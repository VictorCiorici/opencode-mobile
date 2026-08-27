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
    private Process opencodeProcess;

    public static synchronized ProcessManager getInstance() {
        if (instance == null) {
            instance = new ProcessManager();
        }
        return instance;
    }

    public synchronized void startProcesses(Context context) {
        if (isServerHealthy("http://127.0.0.1:8787/api/health")) {
            Log.i(TAG, "Bridge server is already running");
            return;
        }

        File filesDir = context.getFilesDir();
        File serverDir = new File(filesDir, "server");
        File logFile = new File(filesDir, "daemon.log");

        try {
            Map<String, String> env = new HashMap<>(System.getenv());
            env.put("HOME", filesDir.getAbsolutePath());
            env.put("TMPDIR", context.getCacheDir().getAbsolutePath());
            env.put("OCMB_WORKSPACE", new File(filesDir, "projects").getAbsolutePath());

            File binDir = new File(filesDir, "bin");
            if (binDir.exists()) {
                env.put("PATH", binDir.getAbsolutePath() + ":" + env.get("PATH"));
            }

            // Start bridge using python3 / uvicorn if available on system or bundled
            String pythonBin = new File(binDir, "python3").exists() ? new File(binDir, "python3").getAbsolutePath() : "python3";

            ProcessBuilder pb = new ProcessBuilder(
                pythonBin, "-m", "uvicorn", "ocmb.main:app",
                "--app-dir", serverDir.getAbsolutePath(),
                "--host", "127.0.0.1",
                "--port", "8787"
            );
            pb.environment().putAll(env);
            pb.directory(filesDir);
            pb.redirectErrorStream(true);

            bridgeProcess = pb.start();

            // Pipe output to daemon.log
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

            Log.i(TAG, "Bridge process started");

        } catch (Exception e) {
            Log.e(TAG, "Failed to start daemon processes", e);
        }
    }

    public synchronized void stopProcesses() {
        if (bridgeProcess != null) {
            bridgeProcess.destroy();
            bridgeProcess = null;
        }
        if (opencodeProcess != null) {
            opencodeProcess.destroy();
            opencodeProcess = null;
        }
        Log.i(TAG, "Daemon processes stopped");
    }

    public static boolean isServerHealthy(String urlStr) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(600);
            conn.setReadTimeout(600);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            return (code >= 200 && code < 400);
        } catch (Exception e) {
            return false;
        }
    }
}
