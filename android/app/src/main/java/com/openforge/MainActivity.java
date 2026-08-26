package com.openforge;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final String PREFS = "openforge";
    private static final String KEY_URL = "bridge_url";
    private static final String DEFAULT_URL = "http://127.0.0.1:8787/ui/";
    private WebView web;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = sp.getString(KEY_URL, DEFAULT_URL);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        web.setWebViewClient(new WebViewClient());
        setContentView(web);
        web.loadUrl(url);

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
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
