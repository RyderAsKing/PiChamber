package com.pichamber.app;

import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

@CapacitorPlugin(name = "PiChamberFiles")
public class PiChamberFilesPlugin extends Plugin {

    @PluginMethod
    public void share(PluginCall call) {
        String base64Data = call.getString("base64");
        if (base64Data == null || base64Data.trim().isEmpty()) {
            call.reject("Base64 data is required");
            return;
        }

        String rawFilename = call.getString("filename", "file");
        String sanitizedFilename = sanitizeFilename(rawFilename);

        String mimeType = call.getString("mimeType");
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "application/octet-stream";
        } else {
            // Share targets match on the bare type; drop parameters like charset.
            mimeType = mimeType.split(";", 2)[0].trim();
            if (mimeType.isEmpty()) mimeType = "application/octet-stream";
        }

        try {
            File cacheDir = getContext().getCacheDir();
            File sharedDir = new File(cacheDir, "shared");
            if (!sharedDir.exists() && !sharedDir.mkdirs()) {
                if (!sharedDir.exists()) {
                    call.reject("Failed to create shared directory");
                    return;
                }
            }

            // Clear old files in cache/shared/ first
            File[] oldFiles = sharedDir.listFiles();
            if (oldFiles != null) {
                for (File oldFile : oldFiles) {
                    try {
                        //noinspection ResultOfMethodCallIgnored
                        oldFile.delete();
                    } catch (Exception ignored) {
                    }
                }
            }

            File targetFile = new File(sharedDir, sanitizedFilename);
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);

            try (FileOutputStream fos = new FileOutputStream(targetFile)) {
                fos.write(bytes);
                fos.flush();
            }

            String authority = getContext().getPackageName() + ".fileprovider";
            Uri contentUri = FileProvider.getUriForFile(getContext(), authority, targetFile);

            Intent sendIntent = new Intent(Intent.ACTION_SEND);
            sendIntent.setType(mimeType);
            sendIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
            sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(sendIntent, sanitizedFilename);
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            getActivity().startActivity(chooser);

            JSObject ret = new JSObject();
            ret.put("status", "shared");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to share file: " + e.getMessage());
        }
    }

    @PluginMethod
    public void setWebViewBackground(PluginCall call) {
        String colorStr = call.getString("color");
        if (colorStr == null || colorStr.trim().isEmpty()) {
            call.reject("Color is required");
            return;
        }

        try {
            final int parsedColor = Color.parseColor(colorStr.trim());
            getActivity().runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (getBridge() != null && getBridge().getWebView() != null) {
                            getBridge().getWebView().setBackgroundColor(parsedColor);
                        }
                        call.resolve();
                    } catch (Exception e) {
                        call.reject("Failed to set webview background: " + e.getMessage());
                    }
                }
            });
        } catch (IllegalArgumentException e) {
            call.reject("Invalid color format: " + colorStr);
        } catch (Exception e) {
            call.reject("Failed to set background color: " + e.getMessage());
        }
    }

    private static String sanitizeFilename(String filename) {
        if (filename == null) {
            return "file";
        }
        String nameOnly = new File(filename).getName();
        String cleaned = nameOnly.replaceAll("[/\\\\\\r\\n\\0]", "_").trim();
        if (cleaned.length() > 100) {
            int extIdx = cleaned.lastIndexOf('.');
            if (extIdx > 0 && cleaned.length() - extIdx <= 15) {
                String ext = cleaned.substring(extIdx);
                String base = cleaned.substring(0, 100 - ext.length());
                cleaned = base + ext;
            } else {
                cleaned = cleaned.substring(0, 100);
            }
        }
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) {
            return "file";
        }
        return cleaned;
    }
}
