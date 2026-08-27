package com.openforge;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.webkit.WebViewAssetLoader;

public class MainActivity extends Activity {
    private static final String TAG = "MainActivity";
    private static final String PREFS = "openforge";
    private static final String KEY_URL = "bridge_url";
    // Secure WebView-served copy of the bundled UI shell (androidx.webkit asset loader).
    private static final String ASSET_URL = "https://appassets.androidplatform.net/assets/index.html";
    private static final int FILE_CHOOSER_REQ = 1001;
    private static final int REQ_POST_NOTIFICATIONS = 2001;
    private static final int REQ_LEGACY_STORAGE = 2002;

    private WebView web;
    private FrameLayout splashView;
    private ValueCallback<Uri[]> uploadMessage;
    private Handler handler = new Handler(Looper.getMainLooper());
    private boolean loaded = false;

    /** Exposes the generated bearer token to the PWA so it can authenticate
     *  against the local daemon without shipping it through URLs or prefs. */
    public class OpenForgeBridge {
        @JavascriptInterface
        public String bridgeToken() {
            return ProcessManager.ensureBridgeToken(MainActivity.this);
        }
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        // Dark theme status bar and navigation bar matching OpenForge (#0B0E14)
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setStatusBarColor(0xFF0B0E14);
        w.setNavigationBarColor(0xFF0B0E14);

        // Start background daemon service
        try {
            Intent serviceIntent = new Intent(this, DaemonService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
        } catch (Exception ignored) {}

        requestNeededPermissions();
        maybePromptAllFilesAccess();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0B0E14);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // Security hardening: the UI is served from an https asset-loader origin,
        // so file:// access (and its universal cross-origin escape hatch) is off.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        // Secure origin for the bundled UI: intercept appassets.androidplatform.net
        // and map /assets/* onto the APK assets/web/ folder (populated by CI).
        final WebViewAssetLoader.AssetsPathHandler assetHandler =
                new WebViewAssetLoader.AssetsPathHandler(getAssets());
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", path -> assetHandler.handle("web/" + path))
                .build();

        web.addJavascriptInterface(new OpenForgeBridge(), "OpenForgeBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String u) {
                if (splashView != null && !loaded) {
                    loaded = true;
                    splashView.setVisibility(View.GONE);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                handleMainFrameError(request.getUrl().toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                handleMainFrameError(failingUrl);
            }

            private void handleMainFrameError(String failingUrl) {
                // The shell itself comes from local assets, so failures are rare.
                // Never fall into a redirect loop back to ourselves; just hide the
                // splash — the WebView shows whatever rendered before the error.
                boolean selfLoop = failingUrl != null && failingUrl.startsWith(ASSET_URL);
                if (!selfLoop && web != null) {
                    web.loadUrl(ASSET_URL);
                } else if (splashView != null) {
                    loaded = true;
                    splashView.setVisibility(View.GONE);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (uploadMessage != null) {
                    uploadMessage.onReceiveValue(null);
                    uploadMessage = null;
                }
                uploadMessage = filePathCallback;
                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQ);
                } catch (Exception e) {
                    uploadMessage = null;
                    return false;
                }
                return true;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // Splash / Loading View
        splashView = new FrameLayout(this);
        splashView.setBackgroundColor(0xFF0B0E14);
        ProgressBar spinner = new ProgressBar(this);
        FrameLayout.LayoutParams spinLp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        spinLp.gravity = Gravity.CENTER;
        spinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(0xFF4F8CFF));
        splashView.addView(spinner, spinLp);

        TextView label = new TextView(this);
        label.setText("Starting OpenForge AI Engine…");
        label.setTextColor(Color.WHITE);
        label.setTextSize(14);
        FrameLayout.LayoutParams labelLp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        labelLp.gravity = Gravity.CENTER;
        labelLp.topMargin = 120;
        label.setId(View.generateViewId());
        splashView.addView(label, labelLp);

        TextView hint = new TextView(this);
        hint.setText("The daemon runs locally — first launch can take a moment.");
        hint.setTextColor(0xFF8A93A6);
        hint.setTextSize(12);
        FrameLayout.LayoutParams hintLp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        hintLp.gravity = Gravity.CENTER;
        hintLp.topMargin = 150;
        splashView.addView(hint, hintLp);

        root.addView(splashView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);

        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        // Honour explicit developer overrides only if they point somewhere real.
        String url = sp.getString(KEY_URL, ASSET_URL);
        if (url == null || url.startsWith("file://") || url.isEmpty()) {
            url = ASSET_URL;
        }
        String targetUrl = url;
        waitForServerAndLoad(targetUrl);
    }

    private void requestNeededPermissions() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS);
            }
            // Android 11+ relies on MANAGE_EXTERNAL_STORAGE for /sdcard workspaces.
            if (!Environment.isExternalStorageManager()) {
                maybePromptAllFilesAccess();
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED ||
                checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{
                        Manifest.permission.READ_EXTERNAL_STORAGE,
                        Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_LEGACY_STORAGE);
            }
        }
    }

    private boolean allFilesPromptShown = false;

    private void maybePromptAllFilesAccess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || allFilesPromptShown) return;
        if (Environment.isExternalStorageManager()) return;
        allFilesPromptShown = true;
        new AlertDialog.Builder(this)
                .setTitle("Storage access")
                .setMessage("To create and edit projects in shared storage (e.g. /sdcard/OpenForge), grant OpenForge \"All files access\". You can skip this and projects will live in the app's private storage instead.")
                .setPositiveButton("Grant", (d, which) -> {
                    try {
                        startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                                Uri.parse("package:" + getPackageName())));
                    } catch (Exception e) {
                        try {
                            startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                        } catch (Exception ignored) {}
                    }
                })
                .setNegativeButton("Skip", null)
                .show();
    }

    private void waitForServerAndLoad(String targetUrl) {
        new Thread(() -> {
            for (int i = 0; i < 40; i++) {
                if (ProcessManager.isServerHealthy("http://127.0.0.1:8787/api/health")) {
                    break;
                }
                try { Thread.sleep(200); } catch (Exception ignored) {}
            }
            handler.post(() -> {
                web.loadUrl(targetUrl);
                handler.postDelayed(() -> {
                    if (splashView != null) splashView.setVisibility(View.GONE);
                }, 400);
            });
        }).start();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQ) {
            if (uploadMessage != null) {
                Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                uploadMessage.onReceiveValue(results);
                uploadMessage = null;
            }
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
