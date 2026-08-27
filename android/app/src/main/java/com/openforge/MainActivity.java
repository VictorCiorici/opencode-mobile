package com.openforge;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final String PREFS = "openforge";
    private static final String KEY_URL = "bridge_url";
    private static final String DEFAULT_URL = "http://127.0.0.1:8787/ui/";
    private static final int FILE_CHOOSER_REQ = 1001;

    private WebView web;
    private FrameLayout splashView;
    private ValueCallback<Uri[]> uploadMessage;
    private Handler handler = new Handler(Looper.getMainLooper());
    private boolean loaded = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        // Dark theme status bar and navigation bar matching OpenForge (#0B0E14)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Window w = getWindow();
            w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            w.setStatusBarColor(0xFF0B0E14);
            w.setNavigationBarColor(0xFF0B0E14);
        }

        // Start background daemon service
        try {
            Intent serviceIntent = new Intent(this, DaemonService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
        } catch (Exception ignored) {}

        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = sp.getString(KEY_URL, DEFAULT_URL);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF0B0E14);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String u) {
                if (splashView != null && !loaded) {
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
        splashView.addView(spinner, spinLp);

        TextView label = new TextView(this);
        label.setText("Starting OpenForge AI Engine…");
        label.setTextColor(Color.WHITE);
        label.setTextSize(14);
        FrameLayout.LayoutParams labelLp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        labelLp.gravity = Gravity.CENTER;
        labelLp.topMargin = 120;
        splashView.addView(label, labelLp);

        root.addView(splashView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);

        // Long-press to change the bridge URL (e.g. an SSH-tunneled host).
        web.setOnLongClickListener(v -> {
            android.app.AlertDialog.Builder d = new android.app.AlertDialog.Builder(this);
            final android.widget.EditText input = new android.widget.EditText(this);
            input.setText(url);
            d.setTitle("OpenForge bridge URL").setView(input)
              .setPositiveButton("Save", (dialog, which) -> {
                  String u = input.getText().toString().trim();
                  if (!u.isEmpty()) {
                      sp.edit().putString(KEY_URL, u).apply();
                      web.loadUrl(u);
                  }
              }).setNegativeButton("Cancel", null).show();
            return true;
        });

        waitForServerAndLoad(url);
    }

    private void waitForServerAndLoad(String targetUrl) {
        new Thread(() -> {
            boolean ready = false;
            for (int i = 0; i < 30; i++) {
                if (ProcessManager.isServerHealthy("http://127.0.0.1:8787/api/health")) {
                    ready = true;
                    break;
                }
                try { Thread.sleep(400); } catch (Exception ignored) {}
            }
            handler.post(() -> {
                web.loadUrl(targetUrl);
                handler.postDelayed(() -> {
                    if (splashView != null) splashView.setVisibility(View.GONE);
                }, 1500);
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
