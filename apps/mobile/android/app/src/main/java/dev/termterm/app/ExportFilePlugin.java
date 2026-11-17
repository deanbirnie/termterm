package dev.termterm.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saves and opens vault export files through Android's own file picker, so the
 * user chooses where they go (Downloads, Drive, a USB stick...) and the app
 * needs no storage permission.
 */
@CapacitorPlugin(name = "ExportFile")
public class ExportFilePlugin extends Plugin {

  private static final int MAX_BYTES = 50 * 1024 * 1024;

  @PluginMethod
  public void save(PluginCall call) {
    if (call.getString("text") == null) {
      call.reject("Nothing to save");
      return;
    }
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("application/octet-stream");
    intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "termterm-export.termterm"));
    startActivityForResult(call, intent, "saved");
  }

  @ActivityCallback
  private void saved(PluginCall call, ActivityResult result) {
    if (call == null) return;
    Uri uri = result.getData() != null ? result.getData().getData() : null;
    JSObject out = new JSObject();
    if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
      out.put("saved", false);
      call.resolve(out);
      return;
    }
    try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt")) {
      if (os == null) throw new IllegalStateException("The file could not be opened");
      os.write(call.getString("text").getBytes(StandardCharsets.UTF_8));
      out.put("saved", true);
      call.resolve(out);
    } catch (Exception e) {
      call.reject("Could not save the file: " + e.getMessage());
    }
  }

  @PluginMethod
  public void open(PluginCall call) {
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("*/*");
    startActivityForResult(call, intent, "opened");
  }

  @ActivityCallback
  private void opened(PluginCall call, ActivityResult result) {
    if (call == null) return;
    Uri uri = result.getData() != null ? result.getData().getData() : null;
    JSObject out = new JSObject();
    if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
      call.resolve(out);
      return;
    }
    try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
      if (in == null) throw new IllegalStateException("The file could not be opened");
      ByteArrayOutputStream buf = new ByteArrayOutputStream();
      byte[] chunk = new byte[64 * 1024];
      int n;
      while ((n = in.read(chunk)) > 0) {
        buf.write(chunk, 0, n);
        if (buf.size() > MAX_BYTES) throw new IllegalStateException("That file is too large to be a termterm export");
      }
      out.put("name", displayName(uri));
      out.put("text", buf.toString(StandardCharsets.UTF_8.name()));
      call.resolve(out);
    } catch (Exception e) {
      call.reject("Could not read the file: " + e.getMessage());
    }
  }

  private String displayName(Uri uri) {
    try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (c != null && c.moveToFirst()) return c.getString(0);
    } catch (Exception ignored) {
      // The name is only shown to the user.
    }
    return "export file";
  }
}
