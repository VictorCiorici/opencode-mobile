package com.openforge;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class RuntimeInstaller {
    private static final String TAG = "RuntimeInstaller";

    public static synchronized void ensureInstalled(Context context, File targetDir) {
        if (!targetDir.exists()) {
            targetDir.mkdirs();
        }
        try {
            copyAssetFolder(context.getAssets(), "web", new File(targetDir, "pwa"));
            copyAssetFolder(context.getAssets(), "bin", new File(targetDir, "bin"));

            // Check for zipped runtime bundle (e.g., runtime-arm64.zip).
            // Extraction is skipped when the bundle is unchanged (same entry
            // fingerprint already applied) to avoid rewriting ~150 MB on
            // every service start.
            try (InputStream zipIn = context.getAssets().open("runtime-arm64.zip")) {
                String fingerprint = zipFingerprint(zipIn);
                File marker = new File(targetDir, ".runtime_fp");
                String applied = marker.exists()
                        ? new String(readFile(marker)).trim() : "";
                if (!applied.equals(fingerprint)) {
                    try (InputStream zipIn2 = context.getAssets().open("runtime-arm64.zip")) {
                        extractZip(zipIn2, targetDir);
                    }
                    writeFile(marker, fingerprint);
                    Log.i(TAG, "Extracted native runtime bundle (" + fingerprint + ")");
                } else {
                    Log.i(TAG, "Runtime bundle unchanged, skipping extraction");
                }
            } catch (IOException ignored) {
                // Not bundled or separate assets
            }

            // Recursively set executable permission on all binary directories
            setExecutableRecursive(new File(targetDir, "bin"));
            setExecutableRecursive(new File(targetDir, "usr/bin"));

            Log.i(TAG, "Runtime assets successfully initialized in " + targetDir.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Error installing runtime assets", e);
        }
    }

    private static String zipFingerprint(InputStream is) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (ZipInputStream zis = new ZipInputStream(is)) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                sb.append(entry.getName()).append(':').append(entry.getSize()).append(';');
                zis.closeEntry();
            }
        }
        return Integer.toHexString(sb.toString().hashCode());
    }

    private static byte[] readFile(File file) throws IOException {
        try (InputStream in = new java.io.FileInputStream(file)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int len;
            while ((len = in.read(buf)) > 0) out.write(buf, 0, len);
            return out.toByteArray();
        }
    }

    private static void writeFile(File file, String content) throws IOException {
        File parent = file.getParentFile();
        if (parent != null) parent.mkdirs();
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(content.getBytes());
        }
    }

    private static void extractZip(InputStream is, File targetDir) throws IOException {
        try (ZipInputStream zis = new ZipInputStream(is)) {
            ZipEntry entry;
            byte[] buffer = new byte[8192];
            while ((entry = zis.getNextEntry()) != null) {
                File file = new File(targetDir, entry.getName());
                if (entry.isDirectory()) {
                    file.mkdirs();
                } else {
                    if (file.getParentFile() != null) {
                        file.getParentFile().mkdirs();
                    }
                    try (FileOutputStream fos = new FileOutputStream(file)) {
                        int len;
                        while ((len = zis.read(buffer)) > 0) {
                            fos.write(buffer, 0, len);
                        }
                    }
                    if (entry.getName().contains("bin/") || entry.getName().endsWith(".sh")) {
                        file.setExecutable(true, false);
                    }
                }
                zis.closeEntry();
            }
        }
    }

    private static void setExecutableRecursive(File dir) {
        if (dir != null && dir.exists() && dir.isDirectory()) {
            File[] files = dir.listFiles();
            if (files != null) {
                for (File f : files) {
                    if (f.isDirectory()) {
                        setExecutableRecursive(f);
                    } else {
                        f.setExecutable(true, false);
                    }
                }
            }
        }
    }

    private static void copyAssetFolder(AssetManager assetManager, String fromAssetPath, File toDir) throws IOException {
        String[] files = assetManager.list(fromAssetPath);
        if (files == null || files.length == 0) {
            copyAssetFile(assetManager, fromAssetPath, toDir);
        } else {
            if (!toDir.exists()) toDir.mkdirs();
            for (String file : files) {
                String subFrom = fromAssetPath.isEmpty() ? file : fromAssetPath + "/" + file;
                File subTo = new File(toDir, file);
                copyAssetFolder(assetManager, subFrom, subTo);
            }
        }
    }

    private static void copyAssetFile(AssetManager assetManager, String fromAssetPath, File toFile) throws IOException {
        if (toFile.getParentFile() != null && !toFile.getParentFile().exists()) {
            toFile.getParentFile().mkdirs();
        }
        try (InputStream in = assetManager.open(fromAssetPath);
             OutputStream out = new FileOutputStream(toFile)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
        }
    }
}
