package com.openforge;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

public class ProcessManager {
    private static final String TAG = "ProcessManager";
    private static ProcessManager instance;
    private Process bridgeProcess;

    public static synchronized ProcessManager getInstance() {
        if (instance == null) {
            instance = new ProcessManager();
        }
        return instance;
    }

    public synchronized void startProcesses(Context context) {
        if (isServerHealthy("http://127.0.0.1:8787/api/health")) {
            Log.i(TAG, "Bridge server is already healthy on 127.0.0.1:8787");
            return;
        }

        File filesDir = context.getFilesDir();
        File serverDir = new File(filesDir, "server");
        File logFile = new File(filesDir, "daemon.log");
        File pythonHome = new File(filesDir, "python");
        File bundledPython = new File(pythonHome, "bin/python3");

        try {
            Map<String, String> env = new HashMap<>(System.getenv());
            env.put("HOME", filesDir.getAbsolutePath());
            env.put("TMPDIR", context.getCacheDir().getAbsolutePath());
            
            // Default workspace directory
            File defaultWs = new File("/sdcard/OpenForge/projects");
            if (!defaultWs.exists()) {
                defaultWs.mkdirs();
            }
            env.put("OCMB_WORKSPACE", defaultWs.exists() ? defaultWs.getAbsolutePath() : new File(filesDir, "projects").getAbsolutePath());

            // Build PATH and Python environment
            if (pythonHome.exists()) {
                env.put("PYTHONHOME", pythonHome.getAbsolutePath());
                env.put("PYTHONPATH", serverDir.getAbsolutePath() + ":" + new File(pythonHome, "lib/python3.11/site-packages").getAbsolutePath());
                env.put("LD_LIBRARY_PATH", new File(pythonHome, "lib").getAbsolutePath() + (env.containsKey("LD_LIBRARY_PATH") ? ":" + env.get("LD_LIBRARY_PATH") : ""));
            }

            StringBuilder pathBuilder = new StringBuilder();
            if (bundledPython.exists()) {
                pathBuilder.append(bundledPython.getParentFile().getAbsolutePath()).append(":");
            }
            pathBuilder.append(new File(filesDir, "bin").getAbsolutePath()).append(":");
            pathBuilder.append("/data/data/com.termux/files/usr/bin:");
            if (env.containsKey("PATH")) {
                pathBuilder.append(env.get("PATH"));
            }
            env.put("PATH", pathBuilder.toString());

            String pythonExec = bundledPython.exists() ? bundledPython.getAbsolutePath() : "python3";
            Log.i(TAG, "Launching standalone bridge with: " + pythonExec + " (PYTHONHOME=" + env.get("PYTHONHOME") + ")");

            ProcessBuilder pb = new ProcessBuilder(
                pythonExec, "-m", "uvicorn", "ocmb.main:app",
                "--app-dir", serverDir.getAbsolutePath(),
                "--host", "127.0.0.1",
                "--port", "8787"
            );
            pb.environment().putAll(env);
            pb.directory(filesDir);
            pb.redirectErrorStream(true);

            bridgeProcess = pb.start();

            // Pipe daemon logs
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

            Log.i(TAG, "Standalone bridge daemon process successfully launched");

        } catch (Exception e) {
            Log.e(TAG, "Failed to launch standalone bridge process", e);
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
