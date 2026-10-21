package com.openforge;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

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
    private static final String PID_FILE = "daemon.pid";
    private static ProcessManager instance;
    private static final long MAX_LOG_BYTES = 4L * 1024 * 1024;
    private static final int MAX_RESTARTS = 5;
    private Process bridgeProcess;
    /** Set by stopProcesses so the supervisor does not resurrect the daemon. */
    private volatile boolean stopping = false;
    private int restarts = 0;
    private long startedAt = 0;

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

    private static String httpGetBody(String urlStr, int timeoutMs) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            if (conn.getResponseCode() != 200) return null;
            try (InputStream in = conn.getInputStream()) {
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
                return bos.toString("UTF-8");
            }
        } catch (Exception e) {
            return null;
        }
    }

    /** The daemon stamps its build version into /api/health. */
    private static String runningDaemonVersion() {
        String body = httpGetBody("http://127.0.0.1:" + PORT + "/api/health", 400);
        if (body == null) return null;
        try {
            return new JSONObject(body).optString("daemon_version", "");
        } catch (Exception e) {
            return "";
        }
    }

    private static File pidFile(Context context) {
        return new File(context.getFilesDir(), PID_FILE);
    }

    private static int readStalePid(Context context) {
        File f = pidFile(context);
        if (!f.exists()) return -1;
        try (java.util.Scanner sc = new java.util.Scanner(f)) {
            if (!sc.hasNextLine()) return -1;
            return Integer.parseInt(sc.nextLine().trim());
        } catch (Exception e) {
            return -1;
        }
    }

    /** Millis of the current APK's install — distinguishes builds that share a versionName. */
    private static String installStamp(Context context) {
        try {
            return String.valueOf(context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).lastUpdateTime);
        } catch (Exception e) {
            return "unknown";
        }
    }

    private static String readStoredStamp(Context context) {
        File f = pidFile(context);
        if (!f.exists()) return "";
        try (java.util.Scanner sc = new java.util.Scanner(f)) {
            if (!sc.hasNextLine()) return "";
            sc.nextLine(); // pid
            return sc.hasNextLine() ? sc.nextLine().trim() : "";
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * Kills a daemon orphaned by a previous APK update. Native children can
     * outlive the app process, and a healthy-but-old daemon would otherwise
     * block the new binary from ever starting ("already healthy" shortcut).
     * Version strings alone cannot detect this for same-version rebuilds, so
     * the pid file also records the installing APK's lastUpdateTime.
     */
    private static void killStaleDaemon(Context context, String expectedVersion, String installStamp) {
        String running = runningDaemonVersion();
        if (running != null && expectedVersion.equals(running)
                && installStamp.equals(readStoredStamp(context))) {
            Log.i(TAG, "Running daemon is current (" + running + "), reusing it");
            return;
        }
        int stalePid = readStalePid(context);
        if (stalePid > 0) {
            Log.w(TAG, "Killing stale daemon pid=" + stalePid + " version=" + running);
            try {
                android.os.Process.killProcess(stalePid);
            } catch (Exception e) {
                Log.w(TAG, "killProcess failed for " + stalePid, e);
            }
            // Wait for the port to actually free up.
            for (int i = 0; i < 20; i++) {
                if (runningDaemonVersion() == null) break;
                try { Thread.sleep(150); } catch (InterruptedException ignored) { return; }
            }
        }
    }

    private static boolean isAlive(Process p) {
        if (p == null) return false;
        try {
            p.exitValue();
            return false;
        } catch (IllegalThreadStateException e) {
            return true;
        }
    }

    /** Keeps daemon.log bounded: rotate to daemon.log.1 once it grows too big. */
    private static void rotateLog(File logFile) {
        if (logFile.length() > MAX_LOG_BYTES) {
            File old = new File(logFile.getPath() + ".1");
            old.delete();
            logFile.renameTo(old);
        }
    }

    public synchronized void startProcesses(Context context) {
        stopping = false;
        // Service restarts (activity relaunch, fold/unfold) call this repeatedly;
        // a daemon we spawned that is still booting is not "stale" — keep it.
        if (isAlive(bridgeProcess)) {
            Log.i(TAG, "Daemon process already running, not respawning");
            return;
        }
        String myVersion;
        try {
            myVersion = context.getPackageManager()
                    .getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception e) {
            myVersion = "unknown";
        }
        String installStamp = installStamp(context);

        if (isServerHealthy("http://127.0.0.1:" + PORT + "/api/health")) {
            String running = runningDaemonVersion();
            if (myVersion.equals(running) && installStamp.equals(readStoredStamp(context))) {
                Log.i(TAG, "Bridge server is already healthy on 127.0.0.1:" + PORT);
                return;
            }
            Log.w(TAG, "Port " + PORT + " served by a different daemon (version="
                    + running + ", app=" + myVersion + ") — replacing it");
        }
        killStaleDaemon(context, myVersion, installStamp);

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
                cmd.add("-version"); cmd.add(myVersion);
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

            rotateLog(logFile);
            final Process proc = pb.start();
            bridgeProcess = proc;
            startedAt = System.currentTimeMillis();
            writePidFile(context, proc);
            final Context appCtx = context.getApplicationContext();

            // Pipe daemon logs to file, then supervise: an unexpected exit is
            // restarted with backoff so the UI does not silently lose its backend.
            new Thread(() -> {
                try (InputStream in = proc.getInputStream();
                     FileOutputStream out = new FileOutputStream(logFile, true)) {
                    byte[] buf = new byte[4096];
                    int len;
                    while ((len = in.read(buf)) != -1) {
                        out.write(buf, 0, len);
                    }
                } catch (Exception ignored) {}
                int code = -1;
                try { code = proc.waitFor(); } catch (InterruptedException ignored) {}
                onDaemonExit(appCtx, proc, code);
            }, "daemon-supervisor").start();

            Log.i(TAG, "OpenForge native daemon launched successfully");

        } catch (Exception e) {
            Log.e(TAG, "Failed to launch native daemon process", e);
        }
    }

    /** java.lang.Process#pid() exists only on API 26+; resolve reflectively. */
    private static long procPid(Process p) {
        try {
            Object r = Process.class.getMethod("pid").invoke(p);
            return (Long) r;
        } catch (Throwable t) {
            return -1;
        }
    }

    private static void writePidFile(Context context, Process p) {
        try {
            long pid = procPid(p);
            if (pid <= 0) return;
            FileOutputStream out = new FileOutputStream(pidFile(context), false);
            out.write((pid + "\n" + installStamp(context)).getBytes("UTF-8"));
            out.close();
        } catch (Throwable ignored) {}
    }

    private void onDaemonExit(Context context, Process proc, int code) {
        int attempt;
        synchronized (this) {
            if (stopping || proc != bridgeProcess) return;
            bridgeProcess = null;
            // A daemon that ran for a while before dying is a fresh failure,
            // not part of a crash loop.
            if (System.currentTimeMillis() - startedAt > 60000L) restarts = 0;
            if (restarts >= MAX_RESTARTS) {
                Log.e(TAG, "Daemon exited (code " + code + "); giving up after " + restarts + " restarts");
                return;
            }
            attempt = ++restarts;
        }
        long delay = Math.min(30000L, 1000L << (attempt - 1));
        Log.w(TAG, "Daemon exited (code " + code + "); restart " + attempt + " in " + delay + "ms");
        try { Thread.sleep(delay); } catch (InterruptedException e) { return; }
        if (stopping) return;
        startProcesses(context);
    }

    public synchronized void stopProcesses() {
        stopping = true;
        restarts = 0;
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
