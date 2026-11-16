package dev.termterm.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Downloads a newer release's APK into the app's private cache and hands it
 * to Android's package installer, which asks the person to confirm. Android
 * itself refuses an APK signed with a different key, so only a genuine
 * termterm release can replace the installed app; this also checks the file
 * is termterm and newer before offering it.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

  /** Only release files from the project's GitHub releases are downloaded. */
  private static final String ALLOWED_PREFIX = "https://github.com/deanbirnie/termterm/releases/download/";

  private File downloaded;

  private File folder() {
    File dir = new File(getContext().getCacheDir(), "updates");
    if (!dir.exists()) dir.mkdirs();
    return dir;
  }

  @PluginMethod
  public void download(PluginCall call) {
    String url = call.getString("url", "");
    if (!url.startsWith(ALLOWED_PREFIX) || !url.endsWith(".apk")) {
      call.reject("Not a termterm release download");
      return;
    }
    new Thread(() -> {
      File target = new File(folder(), "update.apk");
      File partial = new File(folder(), "update.apk.part");
      try {
        // Earlier downloads are no longer needed.
        File[] old = folder().listFiles();
        if (old != null) for (File f : old) f.delete();

        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        int status = connection.getResponseCode();
        if (status != 200) throw new Exception("The download failed (" + status + ")");
        long total = connection.getContentLengthLong();
        long done = 0;
        int lastPercent = -1;
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(partial)) {
          byte[] buffer = new byte[64 * 1024];
          int n;
          while ((n = in.read(buffer)) != -1) {
            out.write(buffer, 0, n);
            done += n;
            int percent = total > 0 ? (int) (done * 100 / total) : 0;
            if (percent != lastPercent) {
              lastPercent = percent;
              JSObject progress = new JSObject();
              progress.put("percent", percent);
              notifyListeners("progress", progress);
            }
          }
        } finally {
          connection.disconnect();
        }
        if (!partial.renameTo(target)) throw new Exception("Could not save the download");
        checkIsNewerTermterm(target);
        downloaded = target;
        call.resolve();
      } catch (Exception e) {
        partial.delete();
        target.delete();
        call.reject(e.getMessage() != null ? e.getMessage() : "The download failed");
      }
    }).start();
  }

  /** The downloaded file must be this app, at a higher version than the one installed. */
  private void checkIsNewerTermterm(File apk) throws Exception {
    PackageManager pm = getContext().getPackageManager();
    PackageInfo candidate = pm.getPackageArchiveInfo(apk.getAbsolutePath(), 0);
    if (candidate == null) throw new Exception("The downloaded file is not a valid app");
    String self = getContext().getPackageName();
    if (!self.equals(candidate.packageName)) throw new Exception("The downloaded file is not termterm");
    PackageInfo installed = pm.getPackageInfo(self, 0);
    if (versionCode(candidate) <= versionCode(installed)) {
      throw new Exception("The downloaded file is not newer than this app");
    }
  }

  @SuppressWarnings("deprecation")
  private static long versionCode(PackageInfo info) {
    return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode;
  }

  @PluginMethod
  public void install(PluginCall call) {
    if (downloaded == null || !downloaded.exists()) {
      call.reject("Download the update first");
      return;
    }
    // Android 8 and later ask once whether termterm may install apps.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
        && !getContext().getPackageManager().canRequestPackageInstalls()) {
      Intent settings =
          new Intent(
              Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
              Uri.parse("package:" + getContext().getPackageName()));
      settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(settings);
      JSObject out = new JSObject();
      out.put("needsPermission", true);
      call.resolve(out);
      return;
    }
    Uri uri =
        FileProvider.getUriForFile(
            getContext(), getContext().getPackageName() + ".fileprovider", downloaded);
    Intent intent = new Intent(Intent.ACTION_VIEW);
    intent.setDataAndType(uri, "application/vnd.android.package-archive");
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(intent);
    JSObject out = new JSObject();
    out.put("needsPermission", false);
    call.resolve(out);
  }
}
