package com.openforge;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

public class ProcessManager {
    private static final String TAG = "ProcessManager";
    private static final int PORT = 8787;
    private static ProcessManager instance;
    private Process bridgeProcess;

    public static synchronized ProcessManager getInstance() {
        if (instance == null) {
            instance = new ProcessManager();
        }
        return instance;
    }

    /** Stable per-install bearer token the daemon requires for API access. */
    public static synchronized String ensureBridgeToken(Context context) {
        SharedPreferences sp = context.getSharedPreferences("openforge", Context.MODE_PRIVATE);
        String token = sp.getString("bridge_token", null);
        if (token == null || token.isEmpty()) {
            token = UUID.randomUUID().toString().replace("-", "");
            sp.edit().putString("bridge_token", token).apply();
        }
        return token;
    }

    public synchronized void startProcesses(Context context) {
        if (isServerHealthy("http://127.0.0.1:" + PORT + "/api/health")) {
            Log.i(TAG, "Bridge server is already healthy on 127.0.0.1:" + PORT);
            return;
        }

        File filesDir = context.getFilesDir();
        File webDir = new File(filesDir, "pwa");
        File logFile = new File(filesDir, "daemon.log");

        // Default workspace directory
        File defaultWs = new File("/sdcard/OpenForge/projects");
        if (!defaultWs.exists()) {
            defaultWs.mkdirs(); // may fail without storage permission; fallback below
        }
        String workspacePath = defaultWs.exists() ? defaultWs.getAbsolutePath() : new File(filesDir, "projects").getAbsolutePath();
        new File(workspacePath, ".keep").getParentFile().mkdirs();

        // 1. Check for native static daemon in nativeLibraryDir (standard Android APK installation path)
        File nativeDaemon = new File(context.getApplicationInfo().nativeLibraryDir, "libdaemon.so");
        File extractedDaemon = new File(filesDir, "bin/openforge-daemon");

        try {
            Map<String, String> env = new HashMap<>(System.getenv());
            env.put("HOME", filesDir.getAbsolutePath());
            env.put("TMPDIR", context.getCacheDir().getAbsolutePath());
            env.put("OCMB_WORKSPACE", workspacePath);
            String token = ensureBridgeToken(context);

            List<String> cmd = new ArrayList<>();
            boolean daemonFound = false;

            if (nativeDaemon.exists()) {
                nativeDaemon.setExecutable(true, false);
                Log.i(TAG, "Starting native static daemon from: " + nativeDaemon.getAbsolutePath());
                cmd.add(nativeDaemon.getAbsolutePath());
                daemonFound = true;
            } else if (extractedDaemon.exists()) {
                extractedDaemon.setExecutable(true, false);
                Log.i(TAG, "Starting extracted daemon from: " + extractedDaemon.getAbsolutePath());
                cmd.add(extractedDaemon.getAbsolutePath());
                daemonFound = true;
            }

            if (daemonFound) {
                cmd.add("-port"); cmd.add(String.valueOf(PORT));
                cmd.add("-workspace"); cmd.add(workspacePath);
                cmd.add("-data"); cmd.add(new File(filesDir, "data").getAbsolutePath());
                cmd.add("-token"); cmd.add(token);
                if (webDir.exists()) {
                    cmd.add("-web"); cmd.add(webDir.getAbsolutePath());
                }
            } else {
                // No native daemon was bundled (developer build) — fail loudly in the log.
                Log.e(TAG, "No daemon binary found; expected libdaemon.so or assets/bin/openforge-daemon");
                return;
            }

            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.environment().putAll(env);
            pb.directory(filesDir);
            pb.redirectErrorStream(true);

            bridgeProcess = pb.start();

            // Pipe daemon logs to file for debugging
            new Thread(() -> {
                try (InputStream in = bridgeProcess.getInputStream();
                     FileOutputStream out = new FileOutputStream(logFile, true)) {
                    byte[] buf = new byte[4096];
                    int len;
                    while ((len = in.read(buf)) != -1) {
                        out.write(buf, 0, len);
                    }
                } catch (Exception ignored) {}
            }).start();

            Log.i(TAG, "OpenForge native daemon launched successfully");

        } catch (Exception e) {
            Log.e(TAG, "Failed to launch native daemon process", e);
        }
    }

    public synchronized void stopProcesses() {
        if (bridgeProcess != null) {
            bridgeProcess.destroy();
            bridgeProcess = null;
        }
        Log.i(TAG, "Bridge daemon stopped");
    }

    public static boolean isServerHealthy(String urlStr) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(400);
            conn.setReadTimeout(400);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            return (code >= 200 && code < 400);
        } catch (Exception e) {
            return false;
        }
    }
}
