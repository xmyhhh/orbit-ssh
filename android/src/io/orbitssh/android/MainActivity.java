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

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;

/** A local WebView and the shared Go SSH engine, connected by private pipes. */
public final class MainActivity extends Activity implements OrbitEngine.Listener {
    private static final String ORIGIN = "https://appassets.androidplatform.net/";
    private static final String APPEARANCE_PREFS = "OrbitSSH.Appearance";
    private static final int PICK_DOCUMENT = 10;
    private static final int EXPORT_DOCUMENT = 11;
    private final ExecutorService workers = Executors.newFixedThreadPool(2, new ThreadFactory() {
        private int counter;
        @Override public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "orbit-ui-" + (++counter));
            thread.setDaemon(true);
            return thread;
        }
    });
    private final AtomicBoolean failed = new AtomicBoolean();
    private OrbitEngine engine;
    private WebView webView;
    private FrameLayout webContainer;
    private TerminalActionMode terminalActions;
    private TextView loading;
    private boolean darkAppearance;
    private boolean terminalFullscreen;
    private volatile boolean interfaceShown;
    private boolean quitting;
    private int surfaceColor = Color.WHITE;
    private int canvasColor = Color.rgb(247, 248, 250);
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
        engine = OrbitEngine.get(this);
        engine.setListener(this);
        requestNotificationPermission();
        createWebView();
        applySystemAppearance();
        engine.startAsync(getFilesDir(), localFiles);
        // The engine may already be running from an earlier window.
        if (engine.isReady()) showInterface();
    }

    /**
     * The background service needs the notification permission on Android 13
     * and newer, otherwise its notification is never shown.
     */
    private void requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        try {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
        } catch (Exception ignored) {
            // The service still runs without the permission.
        }
    }

    /** Shows the app shell once the engine is ready to serve calls. */
    private void showInterface() {
        if (interfaceShown) return;
        interfaceShown = true;
        runOnUiThread(() -> {
            if (closing) return;
            setContentView(webContainer);
            applySystemAppearance();
            webContainer.requestApplyInsets();
            webView.loadUrl(ORIGIN);
        });
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

    @Override public void onEngineMessage(JSONObject message) {
        deliver(message);
    }

    @Override public void onEngineNative(JSONObject request) {
        String id = request.optString("id");
        try {
            String method = request.getString("method");
            JSONArray args = request.optJSONArray("args");
            if (method.equals("pickFile")) {
                String kind = args.optString(0).contains("私钥") ? "key" : "file";
                runOnUiThread(() -> openPicker(new Picker(id, true, kind, null)));
            } else if (method.equals("importFiles")) {
                runOnUiThread(() -> openPicker(new Picker(id, true, "import", null)));
            } else if (method.equals("confirm")) {
                runOnUiThread(() -> {
                    new AlertDialog.Builder(this).setTitle(args.optString(0)).setMessage(args.optString(1))
                        .setPositiveButton(args.optString(2), (dialog, which) -> engine.replyNative(id, true, null))
                        .setNegativeButton("取消", (dialog, which) -> engine.replyNative(id, false, null))
                        .setOnCancelListener(dialog -> engine.replyNative(id, false, null)).show();
                });
            } else {
                engine.replyNative(id, null, "不支持的系统操作");
            }
        } catch (Exception error) {
            engine.replyNative(id, null, message(error));
        }
    }

    @Override public void onEngineFatal(String error) {
        fatal(error);
    }

    private void writeBackend(JSONObject message) throws Exception {
        engine.send(message);
    }

    private void deliver(JSONObject message) {
        String script = "window.__orbitAndroidReceive && window.__orbitAndroidReceive(" + message.toString() + ")";
        runOnUiThread(() -> {
            if (!closing && webView != null) webView.evaluateJavascript(script, null);
        });
    }

    /** Answers a request that came from the web view. */
    private void reply(String id, Object data, String error) {
        try {
            JSONObject result = new JSONObject().put("type", "result").put("id", id).put("data", data == null ? JSONObject.NULL : data);
            if (error != null) result.put("error", error);
            deliver(result);
        } catch (Exception failure) {
            fatal("Android 桥接中断，请重新打开应用。");
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
                reply(id, null, message(error));
            }
        }
    }

    private void frontendAction(String id, String method, JSONArray args) {
        try {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (method.equals("ClipboardGetText")) {
                ClipData data = clipboard.getPrimaryClip();
                reply(id, data == null || data.getItemCount() == 0 ? "" : data.getItemAt(0).coerceToText(this).toString(), null);
            } else if (method.equals("ClipboardSetText")) {
                clipboard.setPrimaryClip(ClipData.newPlainText("Orbit SSH", args.getString(0)));
                reply(id, true, null);
            } else if (method.equals("ShowTerminalActions")) {
                terminalActions.show(args.getString(0), args.getString(1), args.getJSONObject(2), args.getBoolean(3));
                reply(id, true, null);
            } else if (method.equals("HideTerminalActions")) {
                terminalActions.hide(args.getString(0));
                reply(id, true, null);
            } else if (method.equals("SetTerminalFullscreen")) {
                terminalFullscreen = args.getBoolean(0);
                applyTerminalFullscreen();
                reply(id, true, null);
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
                reply(id, true, null);
            } else {
                InputMethodManager keyboard = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                webView.requestFocus();
                keyboard.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT);
                reply(id, true, null);
            }
        } catch (Exception error) {
            reply(id, null, message(error));
        }
    }

    private void openPicker(Picker picker) {
        if (pendingPicker != null) {
            if (picker.nativeReply) engine.replyNative(picker.id, null, "请先完成当前文件选择");
            else reply(picker.id, null, "请先完成当前文件选择");
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
            if (picker.nativeReply) engine.replyNative(picker.id, null, message(error));
            else reply(picker.id, null, message(error));
        }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_DOCUMENT && requestCode != EXPORT_DOCUMENT) return;
        Picker picker = pendingPicker;
        pendingPicker = null;
        if (picker == null) return;
        if (resultCode != RESULT_OK || data == null) {
            Object value = picker.kind.equals("export") ? (Object) Boolean.FALSE : (Object) "";
            if (picker.nativeReply) engine.replyNative(picker.id, value, null);
            else reply(picker.id, value, null);
            return;
        }
        workers.execute(() -> {
            try {
                if (picker.kind.equals("export")) {
                    try (InputStream input = new FileInputStream(picker.source); OutputStream output = getContentResolver().openOutputStream(data.getData(), "wt")) {
                        copy(input, output);
                    }
                    if (picker.nativeReply) engine.replyNative(picker.id, true, null);
                    else reply(picker.id, true, null);
                } else {
                    File selected = null;
                    ClipData clips = data.getClipData();
                    int count = clips == null ? 1 : clips.getItemCount();
                    for (int i = 0; i < count; i++) {
                        Uri uri = clips == null ? data.getData() : clips.getItemAt(i).getUri();
                        selected = importDocument(uri, picker.kind.equals("key"));
                    }
                    Object value = picker.kind.equals("import") ? localFiles.getAbsolutePath() : selected.getAbsolutePath();
                    if (picker.nativeReply) engine.replyNative(picker.id, value, null);
                    else reply(picker.id, value, null);
                }
            } catch (Exception error) {
                String reason = "文件操作失败：" + message(error);
                if (picker.nativeReply) engine.replyNative(picker.id, null, reason);
                else reply(picker.id, null, reason);
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
            .setPositiveButton("退出", (dialog, which) -> { quitting = true; finish(); }).setNegativeButton("取消", null).show();
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
        if (engine != null) {
            engine.setListener(null);
            // A confirmed exit ends the engine. Otherwise it keeps running so
            // background sessions survive, and the foreground service holds
            // the process while sessions are open.
            if (quitting || !engine.hasActiveSessions()) engine.stop();
        }
        if (webView != null) {
            webView.removeJavascriptInterface("OrbitAndroid");
            webView.destroy();
        }
        workers.shutdownNow();
        super.onDestroy();
    }
}
