package dev.termterm.app;

import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import dev.termterm.app.ssh.SshKeys;
import dev.termterm.app.ssh.SshSession;
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

  private static final class Live {
    SshSession session;
    final Set<String> prompts = ConcurrentHashMap.newKeySet();
  }

  private final Map<String, Live> sessions = new ConcurrentHashMap<>();
  /** Prompts waiting for the interface. The value is a Boolean, String, String[] or null. */
  private final Map<String, CompletableFuture<Object>> prompts = new ConcurrentHashMap<>();

  @PluginMethod
  public void connect(PluginCall call) {
    final String sessionId = call.getString("sessionId");
    String host = call.getString("host");
    String username = call.getString("username");
    if (sessionId == null || host == null || username == null || username.isEmpty()) {
      call.reject("sessionId, host and username are required");
      return;
    }
    end(sessionId);

    SshSession.Config config = new SshSession.Config();
    config.host = host;
    config.port = call.getInt("port", 22);
    config.username = username;
    config.password = call.getString("password");
    config.privateKey = call.getString("privateKey");
    config.passphrase = call.getString("passphrase");
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
                  cancelPrompts(live);
                  status(sessionId, "closed", error);
                }
              }
            },
            new SshSession.Prompter() {
              @Override
              public boolean trustHostKey(byte[] publicKeyBlob) {
                JSObject event = new JSObject();
                event.put("kind", "hostkey");
                event.put("publicKey", Base64.encodeToString(publicKeyBlob, Base64.NO_WRAP));
                return Boolean.TRUE.equals(ask(sessionId, live, event));
              }

              @Override
              public String password(String user, boolean retry) {
                JSObject event = new JSObject();
                event.put("kind", "password");
                event.put("username", user);
                event.put("retry", retry);
                Object answer = ask(sessionId, live, event);
                return answer instanceof String ? (String) answer : null;
              }

              @Override
              public String[] keyboardInteractive(
                  String name, String instruction, String[] questions, boolean[] echo) {
                JSArray list = new JSArray();
                for (int i = 0; i < questions.length; i++) {
                  JSObject question = new JSObject();
                  question.put("prompt", questions[i]);
                  question.put("echo", echo != null && i < echo.length && echo[i]);
                  list.put(question);
                }
                JSObject event = new JSObject();
                event.put("kind", "keyboard");
                event.put("name", name == null ? "" : name);
                event.put("instructions", instruction == null ? "" : instruction);
                event.put("prompts", list);
                Object answer = ask(sessionId, live, event);
                if (!(answer instanceof String[])) return null;
                // The server expects exactly one answer per question.
                return Arrays.copyOf((String[]) answer, questions.length);
              }
            });
    sessions.put(sessionId, live);
    status(sessionId, "connecting", null);
    live.session.start();
    call.resolve();
  }

  @PluginMethod
  public void write(PluginCall call) {
    Live live = sessions.get(call.getString("sessionId", ""));
    String data = call.getString("data");
    if (live != null && data != null) live.session.write(data.getBytes(StandardCharsets.UTF_8));
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
    live.session.close();
    cancelPrompts(live);
  }

  private void status(String sessionId, String state, String error) {
    JSObject event = new JSObject();
    event.put("sessionId", sessionId);
    event.put("state", state);
    if (error != null) event.put("error", error);
    notifyListeners("status", event);
  }
}
