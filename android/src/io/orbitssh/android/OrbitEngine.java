package io.orbitssh.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Owns the shared Go SSH engine and the private pipes to it. The engine
 * outlives the activity, so SSH sessions keep running while the app sits in
 * the background or its window was closed.
 */
public final class OrbitEngine {
    /** Callbacks for the activity that currently shows the engine. */
    interface Listener {
        void onEngineMessage(JSONObject message);
        void onEngineNative(JSONObject request);
        void onEngineFatal(String error);
    }

    private static final String KEY_ALIAS = "OrbitSSH.Credentials.v1";
    private static OrbitEngine instance;

    private final Context context;
    private final ExecutorService workers = Executors.newFixedThreadPool(4, new ThreadFactory() {
        private int counter;
        @Override public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "orbit-worker-" + (++counter));
            thread.setDaemon(true);
            return thread;
        }
    });
    private final Object pipeLock = new Object();
    private final AtomicBoolean failed = new AtomicBoolean();
    private volatile Listener listener;
    private volatile boolean closing;
    private volatile boolean ready;
    private volatile int backgroundSessions;
    private Process backend;
    private BufferedWriter backendInput;
    private File localFiles;

    private OrbitEngine(Context context) {
        this.context = context.getApplicationContext();
    }

    static synchronized OrbitEngine get(Context context) {
        if (instance == null) instance = new OrbitEngine(context);
        return instance;
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    boolean isReady() {
        return ready;
    }

    boolean hasActiveSessions() {
        return backgroundSessions > 0;
    }

    /**
     * Starts the engine on its own thread and returns at once. The engine
     * keeps running until it is stopped, even when no activity is attached.
     */
    void startAsync(File filesDir, File downloads) {
        Thread thread = new Thread(() -> start(filesDir, downloads), "orbit-engine");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * Starts the engine and then reads its messages until it stops. The
     * method blocks for the whole lifetime of the engine, so it must run on a
     * background thread and must not hold the engine monitor while it waits.
     */
    void start(File filesDir, File downloads) {
        Process process;
        synchronized (this) {
            if (backend != null) return;
            closing = false;
            failed.set(false);
            ready = false;
            localFiles = downloads;
            try {
                File executable = new File(context.getApplicationInfo().nativeLibraryDir, "liborbit.so");
                ProcessBuilder builder = new ProcessBuilder(executable.getAbsolutePath(), filesDir.getAbsolutePath(), downloads.getAbsolutePath());
                builder.directory(filesDir);
                builder.environment().put("TMPDIR", context.getCacheDir().getAbsolutePath());
                backend = builder.start();
                backendInput = new BufferedWriter(new OutputStreamWriter(backend.getOutputStream(), StandardCharsets.UTF_8));
            } catch (Exception error) {
                if (!closing) fatal("无法启动 SSH 后端：" + message(error));
                return;
            }
            process = backend;
        }
        Thread errors = new Thread(() -> {
            // Drain stderr so a runtime diagnostic cannot stall the engine.
            try (InputStream input = process.getErrorStream()) {
                byte[] buffer = new byte[4096];
                while (input.read(buffer) >= 0) { }
            } catch (Exception ignored) { }
        }, "orbit-stderr");
        errors.setDaemon(true);
        errors.start();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                JSONObject message = new JSONObject(line);
                String type = message.optString("type");
                if (type.equals("ready")) {
                    ready = true;
                    deliver(message);
                } else if (type.equals("native")) {
                    workers.execute(() -> handleNative(message));
                } else if (type.equals("fatal")) {
                    fatal(message.optString("error", "后端启动失败"));
                } else {
                    deliver(message);
                }
            }
        } catch (Exception ignored) {
            // The engine was stopped or the pipe was closed.
        }
        ready = false;
        // The engine is gone, so the background service has nothing to keep.
        BackgroundService.setActive(context, false, "");
        if (!closing) fatal("SSH 后端已停止，请重新打开应用。");
    }

    /** Stops the engine and releases its process. */
    synchronized void stop() {
        closing = true;
        ready = false;
        backgroundSessions = 0;
        BackgroundService.setActive(context, false, "");
        Process process = backend;
        backend = null;
        synchronized (pipeLock) {
            try { if (backendInput != null) backendInput.close(); } catch (Exception ignored) { }
            backendInput = null;
        }
        if (process != null) process.destroy();
    }

    /** Sends a message to the engine. */
    void send(JSONObject message) throws Exception {
        synchronized (pipeLock) {
            if (closing || backendInput == null) throw new IllegalStateException("SSH 后端尚未启动");
            backendInput.write(message.toString());
            backendInput.newLine();
            backendInput.flush();
        }
    }

    /** Answers a native request that the engine asked for. */
    void replyNative(String id, Object data, String error) {
        try {
            JSONObject result = new JSONObject().put("type", "nativeResult").put("id", id)
                .put("data", data == null ? JSONObject.NULL : data);
            if (error != null) result.put("error", error);
            send(result);
        } catch (Exception failure) {
            fatal("Android 桥接中断，请重新打开应用。");
        }
    }

    private void deliver(JSONObject message) {
        Listener current = listener;
        if (current != null) current.onEngineMessage(message);
    }

    private void fatal(String error) {
        if (!failed.compareAndSet(false, true)) return;
        Listener current = listener;
        if (current != null) current.onEngineFatal(error);
    }

    /**
     * Handles the operations the engine needs from the host. Everything that
     * does not need a window is answered here so background sessions keep
     * working without an activity.
     */
    private void handleNative(JSONObject request) {
        String id = request.optString("id");
        try {
            String method = request.getString("method");
            JSONArray args = request.optJSONArray("args");
            Object value;
            if (method.equals("vaultGet")) {
                value = vaultGet(args.getString(0));
            } else if (method.equals("vaultSet")) {
                vaultSet(args.getString(0), args.getString(1));
                value = "";
            } else if (method.equals("vaultDelete")) {
                if (!vault().edit().remove(args.getString(0)).commit()) throw new IllegalStateException("无法清除凭据");
                value = "";
            } else if (method.equals("resolve")) {
                JSONArray addresses = new JSONArray();
                for (InetAddress address : InetAddress.getAllByName(args.getString(0))) addresses.put(address.getHostAddress());
                value = addresses;
            } else if (method.equals("downloadPath")) {
                String name = new File(args.getString(0)).getName();
                value = new File(localFiles, name).getAbsolutePath();
            } else if (method.equals("setBackground")) {
                int count = args.getInt(0);
                backgroundSessions = count;
                BackgroundService.setActive(context, count > 0, describe(count));
                value = "";
            } else {
                // The remaining operations need a window and are handled by
                // the activity that is currently attached.
                Listener current = listener;
                if (current == null) throw new IllegalStateException("界面未就绪");
                current.onEngineNative(request);
                return;
            }
            replyNative(id, value, null);
        } catch (Exception error) {
            replyNative(id, null, message(error));
        }
    }

    private static String describe(int count) {
        if (count <= 0) return "";
        if (count == 1) return "1 个会话正在后台运行";
        return count + " 个会话正在后台运行";
    }

    private SharedPreferences vault() {
        return context.getSharedPreferences("encrypted-credentials", Context.MODE_PRIVATE);
    }

    private synchronized SecretKey vaultKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }

    private String vaultGet(String key) throws Exception {
        String encoded = vault().getString(key, null);
        if (encoded == null) throw new IllegalStateException("CREDENTIAL_NOT_FOUND");
        JSONObject record = new JSONObject(encoded);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, vaultKey(), new GCMParameterSpec(128, Base64.decode(record.getString("iv"), Base64.NO_WRAP)));
        cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Base64.decode(record.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    private void vaultSet(String key, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, vaultKey());
        cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
        JSONObject record = new JSONObject().put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        if (!vault().edit().putString(key, record.toString()).commit()) throw new IllegalStateException("无法保存加密凭据");
    }

    private static String message(Exception error) {
        String text = error.getMessage();
        return text == null || text.isEmpty() ? error.getClass().getSimpleName() : text;
    }
}
