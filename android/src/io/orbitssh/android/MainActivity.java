package io.orbitssh.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** A local WebView and the shared Go SSH engine, connected by private pipes. */
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net/";
    private static final String KEY_ALIAS = "OrbitSSH.Credentials.v1";
    private static final String APPEARANCE_PREFS = "OrbitSSH.Appearance";
    private static final int PICK_DOCUMENT = 10;
    private static final int EXPORT_DOCUMENT = 11;
    private final ExecutorService workers = Executors.newFixedThreadPool(4);
    private final AtomicBoolean failed = new AtomicBoolean();
    private final Object pipeLock = new Object();
    private WebView webView;
    private FrameLayout webContainer;
    private TerminalActionMode terminalActions;
    private TextView loading;
    private boolean darkAppearance;
    private boolean terminalFullscreen;
    private int surfaceColor = Color.WHITE;
    private int canvasColor = Color.rgb(247, 248, 250);
    private Process backend;
    private BufferedWriter backendInput;
    private File localFiles;
    private Picker pendingPicker;
    private volatile boolean closing;

    private static final class Picker {
        final String id;
        final boolean nativeReply;
        final String kind;
        final File source;
        Picker(String id, boolean nativeReply, String kind, File source) {
            this.id = id;
            this.nativeReply = nativeReply;
            this.kind = kind;
            this.source = source;
        }
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            // Insets below resize the WebView once. Do not also let Android
            // resize/pan its viewport around xterm's hidden input textarea.
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
        }
        SharedPreferences appearance = getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE);
        darkAppearance = appearance.getBoolean("dark", false);
        surfaceColor = appearance.getInt("surface", surfaceColor);
        canvasColor = appearance.getInt("canvas", canvasColor);
        localFiles = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (localFiles == null) localFiles = new File(getFilesDir(), "Downloads");
        localFiles.mkdirs();
        loading = new TextView(this);
        loading.setText("Orbit SSH\n正在启动…");
        loading.setGravity(17);
        loading.setTextSize(20);
        setContentView(loading);
        createWebView();
        applySystemAppearance();
        workers.execute(this::startBackend);
    }

    private void applySystemAppearance() {
        // Android 15+ ignores statusBarColor for target 35. The container
        // paints behind the transparent bars; icon appearance is explicit.
        getWindow().setBackgroundDrawable(new ColorDrawable(surfaceColor));
        boolean edgeToEdge = android.os.Build.VERSION.SDK_INT >= 30;
        getWindow().setStatusBarColor(edgeToEdge ? Color.TRANSPARENT : surfaceColor);
        getWindow().setNavigationBarColor(edgeToEdge ? Color.TRANSPARENT : surfaceColor);
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        if (android.os.Build.VERSION.SDK_INT >= 30 && getWindow().getInsetsController() != null) {
            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            getWindow().getInsetsController().setSystemBarsAppearance(darkAppearance ? 0 : mask, mask);
        } else {
            View decor = getWindow().getDecorView();
            int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            int flags = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(darkAppearance ? flags & ~mask : flags | mask);
        }
        if (webContainer != null) webContainer.setBackgroundColor(surfaceColor);
        if (webView != null) webView.setBackgroundColor(canvasColor);
        if (loading != null) {
            loading.setBackgroundColor(canvasColor);
            loading.setTextColor(darkAppearance ? Color.rgb(123, 197, 164) : Color.rgb(35, 110, 84));
        }
        applyTerminalFullscreen();
    }

    private void applyTerminalFullscreen() {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                if (terminalFullscreen) controller.hide(WindowInsets.Type.systemBars());
                else controller.show(WindowInsets.Type.systemBars());
            }
        } else {
            // Keep adjustResize working on Android 9/10: FULLSCREEN disables it
            // on these versions. Reclaim the navigation bar and app chrome.
            View decor = getWindow().getDecorView();
            int mask = View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            int flags = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(terminalFullscreen ? flags | mask : flags & ~mask);
        }
        if (webContainer != null) webContainer.requestApplyInsets();
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applySystemAppearance();
    }

    @SuppressWarnings("SetJavaScriptEnabled") private void createWebView() {
        webView = new WebView(this) {
            @Override protected void onScrollChanged(int x, int y, int oldX, int oldY) {
                super.onScrollChanged(x, y, oldX, oldY);
                // The document is an app shell. Only its inner scroll areas
                // move; focusing the terminal must never pan the whole page.
                if (x != 0 || y != 0) scrollTo(0, 0);
            }
        };
        terminalActions = new TerminalActionMode(webView, (session, action, text) -> {
            try {
                deliver(new JSONObject().put("type", "event").put("name", "android:terminalAction")
                    .put("args", new JSONArray().put(session).put(action).put(text)));
            } catch (Exception ignored) { }
        });
        webContainer = new FrameLayout(this);
        webContainer.addView(webView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        webView.setBackgroundColor(canvasColor);
        webView.addJavascriptInterface(new FrontendBridge(), "OrbitAndroid");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Never expose the JavaScript bridge to remote pages or frames.
                return !request.getUrl().toString().startsWith(ORIGIN);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"https".equals(uri.getScheme()) || !"appassets.androidplatform.net".equals(uri.getHost())) {
                    return emptyResponse();
                }
                String path = uri.getPath();
                if (path == null || path.contains("..") || path.contains("\\")) return emptyResponse();
                if (path.equals("/")) path = "/index.html";
                try {
                    return new WebResourceResponse(mime(path), "UTF-8", getAssets().open("www" + path));
                } catch (Exception ignored) {
                    return emptyResponse();
                }
            }
        });
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            // Target 35 uses edge-to-edge on Android 15: keep content above the
            // keyboard and away from system bars, including after rotation.
            webContainer.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                try {
                    deliver(new JSONObject().put("type", "event").put("name", "android:viewport")
                        .put("args", new JSONArray().put(new JSONObject().put("keyboardVisible", insets.isVisible(WindowInsets.Type.ime())))));
                } catch (Exception ignored) { }
                return WindowInsets.CONSUMED;
            });
        } else {
            webContainer.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
                android.graphics.Rect visible = new android.graphics.Rect();
                getWindow().getDecorView().getWindowVisibleDisplayFrame(visible);
                boolean keyboardVisible = getResources().getDisplayMetrics().heightPixels - visible.bottom > 140 * getResources().getDisplayMetrics().density;
                try {
                    deliver(new JSONObject().put("type", "event").put("name", "android:viewport")
                        .put("args", new JSONArray().put(new JSONObject().put("keyboardVisible", keyboardVisible))));
                } catch (Exception ignored) { }
            });
        }
    }

    private static WebResourceResponse emptyResponse() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private void startBackend() {
        try {
            File executable = new File(getApplicationInfo().nativeLibraryDir, "liborbit.so");
            ProcessBuilder builder = new ProcessBuilder(executable.getAbsolutePath(), getFilesDir().getAbsolutePath(), localFiles.getAbsolutePath());
            builder.directory(getFilesDir());
            builder.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
            backend = builder.start();
            backendInput = new BufferedWriter(new OutputStreamWriter(backend.getOutputStream(), StandardCharsets.UTF_8));
            Thread errors = new Thread(() -> {
                // Drain stderr so a runtime diagnostic cannot stall the engine.
                try (InputStream input = backend.getErrorStream()) {
                    byte[] buffer = new byte[4096];
                    while (input.read(buffer) >= 0) { }
                } catch (Exception ignored) { }
            }, "orbit-stderr");
            errors.setDaemon(true);
            errors.start();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(backend.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    JSONObject message = new JSONObject(line);
                    String type = message.optString("type");
                    if (type.equals("ready")) {
                        runOnUiThread(() -> {
                            if (closing) return;
                            setContentView(webContainer);
                            applySystemAppearance();
                            webContainer.requestApplyInsets();
                            webView.loadUrl(ORIGIN);
                        });
                    } else if (type.equals("native")) {
                        workers.execute(() -> handleNative(message));
                    } else if (type.equals("fatal")) {
                        fatal(message.optString("error", "后端启动失败"));
                    } else {
                        deliver(message);
                    }
                }
            }
            if (!closing) fatal("SSH 后端已停止，请重新打开应用。");
        } catch (Exception error) {
            if (!closing) fatal("无法启动 SSH 后端：" + message(error));
        }
    }

    private void writeBackend(JSONObject message) throws Exception {
        synchronized (pipeLock) {
            if (closing || backendInput == null) throw new IllegalStateException("SSH 后端尚未启动");
            backendInput.write(message.toString());
            backendInput.newLine();
            backendInput.flush();
        }
    }

    private void deliver(JSONObject message) {
        String script = "window.__orbitAndroidReceive && window.__orbitAndroidReceive(" + message.toString() + ")";
        runOnUiThread(() -> {
            if (!closing && webView != null) webView.evaluateJavascript(script, null);
        });
    }

    private void reply(String id, boolean nativeReply, Object data, String error) {
        try {
            JSONObject result = new JSONObject().put("type", nativeReply ? "nativeResult" : "result").put("id", id).put("data", data == null ? JSONObject.NULL : data);
            if (error != null) result.put("error", error);
            if (nativeReply) writeBackend(result); else deliver(result);
        } catch (Exception failure) {
            if (!closing) fatal("Android 桥接中断，请重新打开应用。");
        }
    }

    private final class FrontendBridge {
        @JavascriptInterface public void postMessage(String json) {
            String id = "";
            try {
                JSONObject request = new JSONObject(json);
                if (!"call".equals(request.optString("type"))) return;
                id = request.getString("id");
                String method = request.getString("method");
                JSONArray args = request.optJSONArray("args");
                final String requestID = id;
                if (method.equals("ClipboardGetText") || method.equals("ClipboardSetText") || method.equals("ShowKeyboard") || method.equals("SetSystemAppearance") || method.equals("ShowTerminalActions") || method.equals("HideTerminalActions") || method.equals("SetTerminalFullscreen")) {
                    runOnUiThread(() -> frontendAction(requestID, method, args));
                } else if (method.equals("ExportLocalFile")) {
                    File source = new File(args.getString(0)).getCanonicalFile();
                    String root = localFiles.getCanonicalPath() + File.separator;
                    if (!source.getPath().startsWith(root) || !source.isFile()) throw new IllegalArgumentException("请选择下载目录中的普通文件");
                    runOnUiThread(() -> openPicker(new Picker(requestID, false, "export", source)));
                } else {
                    writeBackend(request);
                }
            } catch (Exception error) {
                reply(id, false, null, message(error));
            }
        }
    }

    private void frontendAction(String id, String method, JSONArray args) {
        try {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (method.equals("ClipboardGetText")) {
                ClipData data = clipboard.getPrimaryClip();
                reply(id, false, data == null || data.getItemCount() == 0 ? "" : data.getItemAt(0).coerceToText(this).toString(), null);
            } else if (method.equals("ClipboardSetText")) {
                clipboard.setPrimaryClip(ClipData.newPlainText("Orbit SSH", args.getString(0)));
                reply(id, false, true, null);
            } else if (method.equals("ShowTerminalActions")) {
                terminalActions.show(args.getString(0), args.getString(1), args.getJSONObject(2), args.getBoolean(3));
                reply(id, false, true, null);
            } else if (method.equals("HideTerminalActions")) {
                terminalActions.hide(args.getString(0));
                reply(id, false, true, null);
            } else if (method.equals("SetTerminalFullscreen")) {
                terminalFullscreen = args.getBoolean(0);
                applyTerminalFullscreen();
                reply(id, false, true, null);
            } else if (method.equals("SetSystemAppearance")) {
                boolean dark = args.getBoolean(0);
                int surface = Color.parseColor(args.getString(1));
                int canvas = Color.parseColor(args.getString(2));
                darkAppearance = dark;
                surfaceColor = surface;
                canvasColor = canvas;
                applySystemAppearance();
                getSharedPreferences(APPEARANCE_PREFS, MODE_PRIVATE).edit()
                    .putBoolean("dark", dark).putInt("surface", surface).putInt("canvas", canvas).apply();
                reply(id, false, true, null);
            } else {
                InputMethodManager keyboard = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                webView.requestFocus();
                keyboard.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT);
                reply(id, false, true, null);
            }
        } catch (Exception error) {
            reply(id, false, null, message(error));
        }
    }

    private void handleNative(JSONObject request) {
        String id = request.optString("id");
        try {
            String method = request.getString("method");
            JSONArray args = request.optJSONArray("args");
            Object value;
            switch (method) {
                case "vaultGet": value = vaultGet(args.getString(0)); break;
                case "vaultSet": vaultSet(args.getString(0), args.getString(1)); value = ""; break;
                case "vaultDelete":
                    if (!vault().edit().remove(args.getString(0)).commit()) throw new IllegalStateException("无法清除凭据");
                    value = "";
                    break;
                case "resolve":
                    JSONArray addresses = new JSONArray();
                    for (InetAddress address : InetAddress.getAllByName(args.getString(0))) addresses.put(address.getHostAddress());
                    value = addresses;
                    break;
                case "downloadPath":
                    String name = new File(args.getString(0)).getName();
                    value = new File(localFiles, name).getAbsolutePath();
                    break;
                case "pickFile":
                    String kind = args.optString(0).contains("私钥") ? "key" : "file";
                    runOnUiThread(() -> openPicker(new Picker(id, true, kind, null)));
                    return;
                case "importFiles":
                    runOnUiThread(() -> openPicker(new Picker(id, true, "import", null)));
                    return;
                case "confirm":
                    runOnUiThread(() -> {
                        new AlertDialog.Builder(this).setTitle(args.optString(0)).setMessage(args.optString(1))
                            .setPositiveButton(args.optString(2), (dialog, which) -> reply(id, true, true, null))
                            .setNegativeButton("取消", (dialog, which) -> reply(id, true, false, null))
                            .setOnCancelListener(dialog -> reply(id, true, false, null)).show();
                    });
                    return;
                default: throw new IllegalArgumentException("不支持的系统操作");
            }
            reply(id, true, value, null);
        } catch (Exception error) {
            reply(id, true, null, message(error));
        }
    }

    private SharedPreferences vault() { return getSharedPreferences("encrypted-credentials", MODE_PRIVATE); }

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

    private void openPicker(Picker picker) {
        if (pendingPicker != null) {
            reply(picker.id, picker.nativeReply, null, "请先完成当前文件选择");
            return;
        }
        pendingPicker = picker;
        try {
            Intent intent;
            if (picker.kind.equals("export")) {
                intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/octet-stream").addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_TITLE, picker.source.getName());
                startActivityForResult(intent, EXPORT_DOCUMENT);
            } else {
                intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, picker.kind.equals("import"));
                startActivityForResult(intent, PICK_DOCUMENT);
            }
        } catch (Exception error) {
            pendingPicker = null;
            reply(picker.id, picker.nativeReply, null, message(error));
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_DOCUMENT && requestCode != EXPORT_DOCUMENT) return;
        Picker picker = pendingPicker;
        pendingPicker = null;
        if (picker == null) return;
        if (resultCode != RESULT_OK || data == null) {
            reply(picker.id, picker.nativeReply, picker.kind.equals("export") ? false : "", null);
            return;
        }
        workers.execute(() -> {
            try {
                if (picker.kind.equals("export")) {
                    try (InputStream input = new FileInputStream(picker.source); OutputStream output = getContentResolver().openOutputStream(data.getData(), "wt")) {
                        copy(input, output);
                    }
                    reply(picker.id, picker.nativeReply, true, null);
                } else {
                    File selected = null;
                    ClipData clips = data.getClipData();
                    int count = clips == null ? 1 : clips.getItemCount();
                    for (int i = 0; i < count; i++) {
                        Uri uri = clips == null ? data.getData() : clips.getItemAt(i).getUri();
                        selected = importDocument(uri, picker.kind.equals("key"));
                    }
                    reply(picker.id, picker.nativeReply, picker.kind.equals("import") ? localFiles.getAbsolutePath() : selected.getAbsolutePath(), null);
                }
            } catch (Exception error) {
                reply(picker.id, picker.nativeReply, null, "文件操作失败：" + message(error));
            }
        });
    }

    private File importDocument(Uri uri, boolean key) throws Exception {
        if (uri == null) throw new IllegalArgumentException("没有选择文件");
        String name = "imported-file";
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
        }
        name = new File(name == null ? "imported-file" : name).getName().replaceAll("[\\x00-\\x1f\\\\/]", "_");
        if (name.equals(".") || name.equals("..") || name.isEmpty()) name = "imported-file";
        File directory = key ? new File(getFilesDir(), "keys") : localFiles;
        directory.mkdirs();
        File destination = new File(directory, (key ? UUID.randomUUID() + "-" : "") + name);
        if (!key) {
            int index = 1;
            while (destination.exists()) destination = new File(directory, index++ + "-" + name);
        }
        File temporary = File.createTempFile(".orbit-import-", ".tmp", directory);
        try {
            try (InputStream input = getContentResolver().openInputStream(uri); OutputStream output = new FileOutputStream(temporary)) {
                if (input == null) throw new IllegalArgumentException("无法打开此文件");
                byte[] buffer = new byte[65536];
                long total = 0;
                int n;
                while ((n = input.read(buffer)) != -1) {
                    total += n;
                    if (key && total > 1024 * 1024) throw new IllegalArgumentException("私钥文件超过 1 MB");
                    output.write(buffer, 0, n);
                }
            }
            temporary.setReadable(false, false);
            temporary.setWritable(false, false);
            temporary.setReadable(true, true);
            temporary.setWritable(true, true);
            if (!temporary.renameTo(destination)) throw new IllegalStateException("无法保存导入文件");
            return destination;
        } finally {
            temporary.delete();
        }
    }

    private static void copy(InputStream input, OutputStream output) throws Exception {
        if (input == null || output == null) throw new IllegalArgumentException("无法打开文件");
        byte[] buffer = new byte[65536];
        int n;
        while ((n = input.read(buffer)) != -1) output.write(buffer, 0, n);
    }

    @Override public void onBackPressed() {
        if (webView != null) {
            String script = "(() => {"
                + " const close = document.querySelector('.modal [aria-label=\"关闭对话框\"]'); if (close) { close.click(); return true; }"
                + " const backdrop = document.querySelector('.sidebar-backdrop'); if (backdrop) { backdrop.click(); return true; }"
                + " const layout = document.querySelector('.split-toggle[aria-expanded=\"true\"]'); if (layout) { layout.click(); return true; }"
                + " const tools = document.querySelector('[aria-label=\"更多终端操作\"][aria-expanded=\"true\"]'); if (tools) { tools.click(); return true; }"
                + " const fullscreen = document.querySelector('[aria-label=\"退出终端全屏\"]'); if (fullscreen) { fullscreen.click(); return true; }"
                + " return false; })()";
            webView.evaluateJavascript(script, handled -> {
                if (!"true".equals(handled)) confirmExit();
            });
        } else confirmExit();
    }

    private void confirmExit() {
        new AlertDialog.Builder(this).setTitle("退出 Orbit SSH？").setMessage("退出将断开终端会话并停止文件传输，未保存的编辑将丢失。")
            .setPositiveButton("退出", (dialog, which) -> finish()).setNegativeButton("取消", null).show();
    }

    private void fatal(String error) {
        if (closing || !failed.compareAndSet(false, true)) return;
        runOnUiThread(() -> {
            if (!closing && !isFinishing()) new AlertDialog.Builder(this).setTitle("Orbit SSH").setMessage(error)
                .setCancelable(false).setPositiveButton("关闭", (dialog, which) -> finish()).show();
        });
    }

    private static String message(Exception error) {
        String text = error.getMessage();
        return text == null || text.isEmpty() ? error.getClass().getSimpleName() : text;
    }

    @Override protected void onDestroy() {
        closing = true;
        if (terminalActions != null) terminalActions.finish();
        synchronized (pipeLock) {
            try { if (backendInput != null) backendInput.close(); } catch (Exception ignored) { }
        }
        if (backend != null) backend.destroy();
        if (webView != null) {
            webView.removeJavascriptInterface("OrbitAndroid");
            webView.destroy();
        }
        workers.shutdownNow();
        super.onDestroy();
    }
}
