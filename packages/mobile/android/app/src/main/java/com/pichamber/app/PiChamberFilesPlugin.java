package com.pichamber.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

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

        String mimeType = call.getString("mimeType");
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "application/octet-stream";
        } else {
            // Share targets match on the bare type; drop parameters like charset.
            mimeType = mimeType.split(";", 2)[0].trim();
            if (mimeType.isEmpty()) mimeType = "application/octet-stream";
        }

        try {
            String sanitizedFilename = sanitizeFilename(rawFilename);
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

    /**
     * Writes the file into the shared Downloads folder, as a browser download
     * would, and shows a short toast with the saved name. Needs Android 10
     * (API 29) for MediaStore.Downloads; older versions reject with
     * UNSUPPORTED and the caller falls back to the share sheet.
     */
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            call.reject("Saving to Downloads needs Android 10 or later", "UNSUPPORTED");
            return;
        }
        String base64Data = call.getString("base64");
        if (base64Data == null) {
            call.reject("Base64 data is required");
            return;
        }
        ContentResolver resolver = getContext().getContentResolver();
        Uri item = null;
        try {
            String filename = sanitizeFilename(call.getString("filename", "file"));
            String mimeType = resolveMimeType(call.getString("mimeType"), filename);
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);

            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (item == null) {
                call.reject("Could not create the file in Downloads");
                return;
            }
            try (OutputStream out = resolver.openOutputStream(item)) {
                if (out == null) throw new IllegalStateException("No output stream");
                out.write(bytes);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, done, null, null);

            // MediaStore renames on a clash ("notes (1).md"); report the real name.
            String savedName = filename;
            try (Cursor cursor = resolver.query(item, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    String name = cursor.getString(0);
                    if (name != null && !name.isEmpty()) savedName = name;
                }
            }

            final String message = "Saved " + savedName + " to Downloads";
            getActivity().runOnUiThread(() -> Toast.makeText(getContext(), message, Toast.LENGTH_SHORT).show());

            JSObject ret = new JSObject();
            ret.put("status", "saved");
            ret.put("filename", savedName);
            call.resolve(ret);
        } catch (Exception e) {
            if (item != null) {
                try {
                    resolver.delete(item, null, null);
                } catch (Exception ignored) {
                }
            }
            call.reject("Failed to save file: " + e.getMessage());
        }
    }

    /** Bare MIME type; when missing or generic, guessed from the file extension. */
    private static String resolveMimeType(String mimeType, String filename) {
        String bare = mimeType == null ? "" : mimeType.split(";", 2)[0].trim();
        if (!bare.isEmpty() && !bare.equals("application/octet-stream")) return bare;
        int dot = filename.lastIndexOf('.');
        if (dot > 0 && dot < filename.length() - 1) {
            String guessed = MimeTypeMap.getSingleton().getMimeTypeFromExtension(filename.substring(dot + 1).toLowerCase());
            if (guessed != null) return guessed;
        }
        return "application/octet-stream";
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
        // \x00, not \0: Android's ICU regex rejects \0 without octal digits,
        // and the exception crashed the plugin thread on every share.
        String cleaned = nameOnly.replaceAll("[/\\\\\\r\\n\\x00]", "_").trim();
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
