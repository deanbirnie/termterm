package dev.termterm.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import dev.termterm.app.ssh.FileSession;
import dev.termterm.app.ssh.ForwardSession;
import dev.termterm.app.ssh.SshKeys;
import dev.termterm.app.ssh.SshSession;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Bridges {@link SshSession} to the WebView.
 *
 * <p>The interface starts sessions and answers prompts; session output, state
 * changes and prompts come back as events ("data", "status", "prompt"). The
 * vault stays in the WebView: host keys are only reported here, and it is the
 * interface that decides whether one is trusted.
 */
@CapacitorPlugin(name = "Ssh")
public class SshPlugin extends Plugin {

  /** A terminal, port forward or file browser connection, with its open prompts. */
  private static final class Live {
    SshSession session;
    ForwardSession forward;
    FileSession files;
    final Set<String> prompts = ConcurrentHashMap.newKeySet();
  }

  private final Map<String, Live> sessions = new ConcurrentHashMap<>();
  private final Map<String, Live> forwards = new ConcurrentHashMap<>();
  private final Map<String, Live> files = new ConcurrentHashMap<>();
  private volatile boolean askedForNotifications;
  /** Prompts waiting for the interface. The value is a Boolean, String, String[] or null. */
  private final Map<String, CompletableFuture<Object>> prompts = new ConcurrentHashMap<>();

  @PluginMethod
  public void connect(PluginCall call) {
    final String sessionId = call.getString("sessionId");
    if (sessionId == null) {
      call.reject("sessionId is required");
      return;
    }
    SshSession.Config config = configFrom(call);
    if (config == null) return;
    end(sessionId);
    config.cols = call.getInt("cols", 80);
    config.rows = call.getInt("rows", 24);

    final Live live = new Live();
    live.session =
        new SshSession(
            config,
            new SshSession.Events() {
              @Override
              public void connected() {
                status(sessionId, "connected", null);
              }

              @Override
              public void data(byte[] buffer, int length) {
                JSObject event = new JSObject();
                event.put("sessionId", sessionId);
                event.put("data", Base64.encodeToString(buffer, 0, length, Base64.NO_WRAP));
                notifyListeners("data", event);
              }

              @Override
              public void closed(String error) {
                // Only report it if this is still the session the interface knows by that id.
                if (sessions.remove(sessionId, live)) {
                  sessionsChanged();
                  cancelPrompts(live);
                  status(sessionId, "closed", error);
                }
              }
            },
            prompterFor(sessionId, live));
    sessions.put(sessionId, live);
    sessionsChanged();
    status(sessionId, "connecting", null);
    live.session.start();
    call.resolve();
  }

  /**
   * The server to connect to, from a call: host, port, username, credentials,
   * keep-alive and environment, and the jump hosts to go through (nearest
   * first). Rejects the call and returns null if something is missing.
   */
  private SshSession.Config configFrom(PluginCall call) {
    String host = call.getString("host");
    String username = call.getString("username");
    if (host == null || username == null || username.isEmpty()) {
      call.reject("host and username are required");
      return null;
    }
    SshSession.Config config = new SshSession.Config();
    config.host = host;
    config.port = call.getInt("port", 22);
    config.username = username;
    config.password = call.getString("password");
    config.privateKey = call.getString("privateKey");
    config.passphrase = call.getString("passphrase");
    config.keepAliveSeconds = call.getInt("keepAlive", 20);
    JSObject env = call.getObject("env");
    if (env != null) {
      java.util.Iterator<String> names = env.keys();
      while (names.hasNext()) {
        String name = names.next();
        config.env.put(name, env.optString(name, ""));
      }
    }
    JSArray jumps = call.getArray("jumps");
    SshSession.Config inner = config;
    if (jumps != null) {
      try {
        for (int i = 0; i < jumps.length(); i++) {
          org.json.JSONObject j = jumps.getJSONObject(i);
          SshSession.Config hop = new SshSession.Config();
          hop.host = j.getString("host");
          hop.port = j.optInt("port", 22);
          hop.username = j.getString("username");
          hop.password = j.has("password") ? j.optString("password", null) : null;
          hop.privateKey = j.has("privateKey") ? j.optString("privateKey", null) : null;
          hop.passphrase = j.has("passphrase") ? j.optString("passphrase", null) : null;
          hop.keepAliveSeconds = j.optInt("keepAlive", 20);
          inner.jump = hop;
          inner = hop;
        }
      } catch (org.json.JSONException e) {
        call.reject("Unreadable jump host settings");
        return null;
      }
    }
    return config;
  }

  /** Questions from a connection, sent to the interface as "prompt" events tagged with {@code id}. */
  private SshSession.Prompter prompterFor(String id, Live live) {
    return new SshSession.Prompter() {
      @Override
      public boolean trustHostKey(int hop, byte[] publicKeyBlob) {
        JSObject event = new JSObject();
        event.put("kind", "hostkey");
        event.put("hop", hop);
        event.put("publicKey", Base64.encodeToString(publicKeyBlob, Base64.NO_WRAP));
        return Boolean.TRUE.equals(ask(id, live, event));
      }

      @Override
      public String password(int hop, String user, boolean retry) {
        JSObject event = new JSObject();
        event.put("kind", "password");
        event.put("hop", hop);
        event.put("username", user);
        event.put("retry", retry);
        Object answer = ask(id, live, event);
        return answer instanceof String ? (String) answer : null;
      }

      @Override
      public String[] keyboardInteractive(int hop, String name, String instruction, String[] questions, boolean[] echo) {
        JSArray list = new JSArray();
        for (int i = 0; i < questions.length; i++) {
          JSObject question = new JSObject();
          question.put("prompt", questions[i]);
          question.put("echo", echo != null && i < echo.length && echo[i]);
          list.put(question);
        }
        JSObject event = new JSObject();
        event.put("kind", "keyboard");
        event.put("hop", hop);
        event.put("name", name == null ? "" : name);
        event.put("instructions", instruction == null ? "" : instruction);
        event.put("prompts", list);
        Object answer = ask(id, live, event);
        if (!(answer instanceof String[])) return null;
        // The server expects exactly one answer per question.
        return Arrays.copyOf((String[]) answer, questions.length);
      }
    };
  }

  // ---- port forwards ---------------------------------------------------------------

  /** Starts a saved port forward. Its state arrives as "forwardState" events. */
  @PluginMethod
  public void forwardStart(PluginCall call) {
    final String forwardId = call.getString("forwardId");
    if (forwardId == null) {
      call.reject("forwardId is required");
      return;
    }
    SshSession.Config config = configFrom(call);
    if (config == null) return;
    stopForward(forwardId, false);
    ForwardSession.Spec spec = new ForwardSession.Spec();
    spec.kind = call.getString("kind", "local");
    spec.bindHost = call.getString("bindHost", "127.0.0.1");
    spec.bindPort = call.getInt("bindPort", 0);
    spec.destHost = call.getString("destHost");
    spec.destPort = call.getInt("destPort", 0);
    final Live live = new Live();
    live.forward =
        new ForwardSession(
            config,
            spec,
            new ForwardSession.Events() {
              @Override
              public void active() {
                forwardState(forwardId, "active", null, 0);
              }

              @Override
              public void connections(int open) {
                forwardState(forwardId, "active", null, open);
              }

              @Override
              public void closed(String error) {
                if (forwards.remove(forwardId, live)) {
                  sessionsChanged();
                  cancelPrompts(live);
                  forwardState(forwardId, error == null ? "stopped" : "error", error, -1);
                }
              }
            },
            prompterFor(forwardId, live));
    forwards.put(forwardId, live);
    sessionsChanged();
    forwardState(forwardId, "starting", null, -1);
    live.forward.start();
    call.resolve();
  }

  @PluginMethod
  public void forwardStop(PluginCall call) {
    stopForward(call.getString("forwardId", ""), true);
    call.resolve();
  }

  private void stopForward(String forwardId, boolean report) {
    Live live = forwards.remove(forwardId);
    if (live == null) return;
    sessionsChanged();
    live.forward.stop();
    cancelPrompts(live);
    if (report) forwardState(forwardId, "stopped", null, -1);
  }

  private void forwardState(String forwardId, String state, String error, int connections) {
    JSObject event = new JSObject();
    event.put("forwardId", forwardId);
    event.put("state", state);
    if (error != null) event.put("error", error);
    if (connections >= 0) event.put("connections", connections);
    notifyListeners("forwardState", event);
  }

  // ---- files (SFTP) --------------------------------------------------------------------

  /** Opens SFTP for a Files view. Resolves with the home folder once logged in. */
  @PluginMethod
  public void sftpOpen(PluginCall call) {
    final String sessionId = call.getString("sessionId");
    if (sessionId == null) {
      call.reject("sessionId is required");
      return;
    }
    SshSession.Config config = configFrom(call);
    if (config == null) return;
    closeFiles(sessionId);
    final Live live = new Live();
    live.files = new FileSession(config, prompterFor(sessionId, live));
    files.put(sessionId, live);
    sessionsChanged();
    background(
        call,
        () -> {
          try {
            JSObject out = new JSObject();
            out.put("home", live.files.open());
            return out;
          } catch (Exception e) {
            if (files.remove(sessionId, live)) sessionsChanged();
            throw e;
          }
        });
  }

  @PluginMethod
  public void sftpList(PluginCall call) {
    FileSession f = filesFor(call);
    if (f == null) return;
    background(
        call,
        () -> {
          FileSession.Listing l = f.list(call.getString("path"));
          JSObject out = new JSObject();
          out.put("path", l.path);
          out.put("parent", l.parent);
          JSArray entries = new JSArray();
          for (FileSession.Entry e : l.entries) {
            JSObject o = new JSObject();
            o.put("name", e.name);
            o.put("path", e.path);
            o.put("type", e.type);
            o.put("size", e.size);
            o.put("modified", e.modified);
            o.put("mode", e.mode);
            entries.put(o);
          }
          out.put("entries", entries);
          return out;
        });
  }

  @PluginMethod
  public void sftpMkdir(PluginCall call) {
    FileSession f = filesFor(call);
    if (f != null) background(call, () -> { f.mkdir(call.getString("path")); return null; });
  }

  @PluginMethod
  public void sftpRename(PluginCall call) {
    FileSession f = filesFor(call);
    if (f != null) background(call, () -> { f.rename(call.getString("from"), call.getString("to")); return null; });
  }

  @PluginMethod
  public void sftpDelete(PluginCall call) {
    FileSession f = filesFor(call);
    if (f != null) background(call, () -> { f.delete(call.getString("path")); return null; });
  }

  @PluginMethod
  public void sftpChmod(PluginCall call) {
    FileSession f = filesFor(call);
    if (f != null) background(call, () -> { f.chmod(call.getString("path"), call.getInt("mode", -1)); return null; });
  }

  @PluginMethod
  public void sftpReadText(PluginCall call) {
    FileSession f = filesFor(call);
    if (f == null) return;
    background(
        call,
        () -> {
          FileSession.Text t = f.readText(call.getString("path"));
          JSObject out = new JSObject();
          out.put("text", t.text);
          out.put("modified", t.modified);
          out.put("size", t.size);
          return out;
        });
  }

  @PluginMethod
  public void sftpWriteText(PluginCall call) {
    FileSession f = filesFor(call);
    if (f == null) return;
    background(
        call,
        () -> {
          JSObject expected = call.getObject("expected");
          long modified = expected == null ? -1 : expected.getLong("modified");
          long size = expected == null ? -1 : expected.getLong("size");
          FileSession.Text t = f.writeText(call.getString("path"), call.getString("text", ""), modified, size);
          JSObject out = new JSObject();
          out.put("modified", t.modified);
          out.put("size", t.size);
          return out;
        });
  }

  @PluginMethod
  public void sftpClose(PluginCall call) {
    closeFiles(call.getString("sessionId", ""));
    call.resolve();
  }

  /** Downloads a server file to where the user picks (Android's "save as"). Resolves {saved}. */
  @PluginMethod
  public void sftpDownload(PluginCall call) {
    if (filesFor(call) == null) return;
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("*/*");
    intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "download"));
    startActivityForResult(call, intent, "downloadTo");
  }

  @ActivityCallback
  private void downloadTo(PluginCall call, ActivityResult result) {
    if (call == null) return;
    FileSession f = filesFor(call);
    if (f == null) return;
    Uri uri = result.getData() != null ? result.getData().getData() : null;
    if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
      JSObject out = new JSObject();
      out.put("saved", false);
      call.resolve(out);
      return;
    }
    String sessionId = call.getString("sessionId");
    String path = call.getString("path");
    String name = call.getString("name", "download");
    String transferId = UUID.randomUUID().toString();
    background(
        call,
        () -> {
          long total = call.getLong("size", 0L);
          try (OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (os == null) throw new Exception("The file could not be opened");
            transfer(transferId, sessionId, "download", name, 0, total, "running", null);
            long size = f.download(path, os, (done) -> { transfer(transferId, sessionId, "download", name, done, total, "running", null); return true; });
            transfer(transferId, sessionId, "download", name, size, size, "done", null);
          } catch (Exception e) {
            transfer(transferId, sessionId, "download", name, 0, total, "error", e.getMessage());
            throw e;
          }
          JSObject out = new JSObject();
          out.put("saved", true);
          return out;
        });
  }

  /** Uploads files the user picks into a server folder. Resolves {count}. */
  @PluginMethod
  public void sftpUpload(PluginCall call) {
    if (filesFor(call) == null) return;
    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType("*/*");
    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
    startActivityForResult(call, intent, "uploadFrom");
  }

  @ActivityCallback
  private void uploadFrom(PluginCall call, ActivityResult result) {
    if (call == null) return;
    FileSession f = filesFor(call);
    if (f == null) return;
    java.util.List<Uri> uris = new java.util.ArrayList<>();
    Intent data = result.getData();
    if (result.getResultCode() == Activity.RESULT_OK && data != null) {
      if (data.getClipData() != null) {
        for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
      } else if (data.getData() != null) {
        uris.add(data.getData());
      }
    }
    String sessionId = call.getString("sessionId");
    String folder = call.getString("folder");
    background(
        call,
        () -> {
          int count = 0;
          for (Uri uri : uris) {
            String[] meta = nameAndSize(uri);
            String name = meta[0];
            long total = Long.parseLong(meta[1]);
            String transferId = UUID.randomUUID().toString();
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
              if (in == null) throw new Exception("The file could not be opened");
              transfer(transferId, sessionId, "upload", name, 0, total, "running", null);
              f.upload(in, folder, name, (done) -> { transfer(transferId, sessionId, "upload", name, done, total, "running", null); return true; });
              transfer(transferId, sessionId, "upload", name, total, total, "done", null);
              count++;
            } catch (Exception e) {
              transfer(transferId, sessionId, "upload", name, 0, total, "error", e.getMessage());
              throw e;
            }
          }
          JSObject out = new JSObject();
          out.put("count", count);
          return out;
        });
  }

  private String[] nameAndSize(Uri uri) {
    String name = "upload";
    long size = 0;
    try (Cursor c =
        getContext().getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        if (!c.isNull(0)) name = c.getString(0);
        if (!c.isNull(1)) size = c.getLong(1);
      }
    } catch (Exception ignored) {
      // name and size are only for display
    }
    return new String[] {name, Long.toString(size)};
  }

  private long lastTransferEvent;

  /** Progress for the transfer list; at most ten updates a second while running. */
  private void transfer(String id, String sessionId, String direction, String name, long done, long total, String state, String error) {
    long now = System.currentTimeMillis();
    if ("running".equals(state) && done > 0 && now - lastTransferEvent < 100) return;
    lastTransferEvent = now;
    JSObject event = new JSObject();
    event.put("id", id);
    event.put("sessionId", sessionId);
    event.put("direction", direction);
    event.put("name", name);
    event.put("done", done);
    event.put("total", total);
    event.put("state", state);
    if (error != null) event.put("error", error);
    notifyListeners("transfer", event);
  }

  private FileSession filesFor(PluginCall call) {
    Live live = files.get(call.getString("sessionId", ""));
    if (live == null) {
      call.reject("Not connected");
      return null;
    }
    return live.files;
  }

  private void closeFiles(String sessionId) {
    Live live = files.remove(sessionId);
    if (live == null) return;
    sessionsChanged();
    live.files.close();
    cancelPrompts(live);
  }

  private interface Work {
    JSObject run() throws Exception;
  }

  /** Runs blocking SSH work off the main thread, then answers the call. */
  private void background(PluginCall call, Work work) {
    Thread t =
        new Thread(
            () -> {
              try {
                JSObject out = work.run();
                if (out == null) call.resolve();
                else call.resolve(out);
              } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
              }
            },
            "ssh-call");
    t.setDaemon(true);
    t.start();
  }

  @PluginMethod
  public void write(PluginCall call) {
    String sessionId = call.getString("sessionId", "");
    Live live = sessions.get(sessionId);
    String data = call.getString("data");
    if (live == null) {
      Log.w("termterm", "Input for a session that is not open: " + sessionId);
    } else if (data != null) {
      try {
        live.session.write(data.getBytes(StandardCharsets.UTF_8));
      } catch (Exception e) {
        Log.w("termterm", "Input could not be sent to " + sessionId, e);
      }
    }
    call.resolve();
  }

  @PluginMethod
  public void resize(PluginCall call) {
    Live live = sessions.get(call.getString("sessionId", ""));
    if (live != null) live.session.resize(call.getInt("cols", 0), call.getInt("rows", 0));
    call.resolve();
  }

  @PluginMethod
  public void close(PluginCall call) {
    end(call.getString("sessionId", ""));
    call.resolve();
  }

  /** The interface's answer to a "prompt" event: accepted (host key), value, or values. */
  @PluginMethod
  public void promptReply(PluginCall call) {
    CompletableFuture<Object> waiting = prompts.remove(call.getString("promptId", ""));
    if (waiting != null) {
      Object answer = null;
      try {
        if (call.getData().has("values")) {
          JSArray values = call.getArray("values");
          String[] answers = new String[values.length()];
          for (int i = 0; i < answers.length; i++) answers[i] = values.optString(i, "");
          answer = answers;
        } else if (call.getData().has("value")) {
          answer = call.getString("value");
        } else if (call.getData().has("accepted")) {
          answer = call.getBoolean("accepted", false);
        }
      } catch (Exception e) {
        answer = null; // an unreadable answer counts as a cancellation
      }
      waiting.complete(answer);
    }
    call.resolve();
  }

  @PluginMethod
  public void generateKey(PluginCall call) {
    try {
      call.resolve(describe(SshKeys.generate(call.getString("type", "ed25519"))));
    } catch (SshKeys.KeyException e) {
      call.reject(e.getMessage());
    }
  }

  @PluginMethod
  public void inspectKey(PluginCall call) {
    String privateKey = call.getString("privateKey");
    if (privateKey == null) {
      call.reject("privateKey is required");
      return;
    }
    try {
      call.resolve(describe(SshKeys.inspect(privateKey, call.getString("passphrase"))));
    } catch (SshKeys.KeyException e) {
      call.reject(e.getMessage());
    }
  }

  @Override
  protected void handleOnDestroy() {
    for (String id : sessions.keySet()) end(id);
    for (String id : forwards.keySet()) stopForward(id, false);
    for (String id : files.keySet()) closeFiles(id);
  }

  private static JSObject describe(SshKeys.Result key) {
    JSObject out = new JSObject();
    out.put("privateKey", key.privateKey);
    out.put("publicKey", Base64.encodeToString(key.publicKeyBlob, Base64.NO_WRAP));
    out.put("keyType", key.keyType);
    return out;
  }

  /** Sends a prompt to the interface and blocks this (connection) thread for the answer. */
  private Object ask(String sessionId, Live live, JSObject event) {
    String promptId = UUID.randomUUID().toString();
    CompletableFuture<Object> waiting = new CompletableFuture<>();
    prompts.put(promptId, waiting);
    live.prompts.add(promptId);
    event.put("promptId", promptId);
    event.put("sessionId", sessionId);
    notifyListeners("prompt", event);
    try {
      return waiting.get();
    } catch (Exception e) {
      return null;
    } finally {
      prompts.remove(promptId);
      live.prompts.remove(promptId);
    }
  }

  private void cancelPrompts(Live live) {
    for (String promptId : live.prompts) {
      CompletableFuture<Object> waiting = prompts.remove(promptId);
      if (waiting != null) waiting.complete(null);
    }
  }

  /** Ends a session the interface asked to close. No "closed" status is sent for it. */
  private void end(String sessionId) {
    Live live = sessions.remove(sessionId);
    if (live == null) return;
    sessionsChanged();
    live.session.close();
    cancelPrompts(live);
  }

  /**
   * Keeps the foreground service (and its notification) in step with the
   * number of open sessions, so Android does not cut them off in the background.
   */
  private void sessionsChanged() {
    int count = sessions.size() + forwards.size() + files.size();
    if (count > 0) askForNotifications();
    SessionService.update(getContext(), count);
  }

  /** Android 13+ hides the service's notification unless the user allows notifications. */
  private void askForNotifications() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || askedForNotifications) return;
    askedForNotifications = true;
    if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
        != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(
          getActivity(), new String[] {Manifest.permission.POST_NOTIFICATIONS}, 0);
    }
  }

  private void status(String sessionId, String state, String error) {
    JSObject event = new JSObject();
    event.put("sessionId", sessionId);
    event.put("state", state);
    if (error != null) event.put("error", error);
    notifyListeners("status", event);
  }
}
