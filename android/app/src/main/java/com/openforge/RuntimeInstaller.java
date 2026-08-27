package com.openforge;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class RuntimeInstaller {
    private static final String TAG = "RuntimeInstaller";

    public static synchronized void ensureInstalled(Context context, File targetDir) {
        if (!targetDir.exists()) {
            targetDir.mkdirs();
        }
        try {
            copyAssetFolder(context.getAssets(), "server", new File(targetDir, "server"));
            copyAssetFolder(context.getAssets(), "web", new File(targetDir, "pwa"));
            File binDir = new File(targetDir, "bin");
            if (binDir.exists()) {
                for (File f : binDir.listFiles()) {
                    f.setExecutable(true, false);
                }
            }
            Log.i(TAG, "Runtime assets successfully installed to " + targetDir.getAbsolutePath());
        } catch (Exception e) {
            Log.e(TAG, "Error installing runtime assets", e);
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
