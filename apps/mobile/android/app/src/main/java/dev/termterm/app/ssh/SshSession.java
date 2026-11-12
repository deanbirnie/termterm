package dev.termterm.app.ssh;

import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.UIKeyboardInteractive;
import com.jcraft.jsch.UserInfo;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;

/**
 * One SSH connection with an interactive shell.
 *
 * <p>This class has no Android dependencies, so it can be compiled and tested
 * on any JVM. {@code SshPlugin} wraps it for the WebView.
 *
 * <p>Everything that needs a decision from the user (trusting a host key,
 * typing a password) goes through {@link Prompter}, whose methods block the
 * connection thread until an answer arrives. No credentials are sent before
 * the host key has been accepted.
 */
public final class SshSession {

  /** Callbacks for what the connection produces. Called on the connection thread. */
  public interface Events {
    void connected();

    void data(byte[] buffer, int length);

    /** Called exactly once. {@code error} is null for a normal end. */
    void closed(String error);
  }

  /** Questions for the user. Each call blocks until answered; null or false means "cancel". */
  public interface Prompter {
    boolean trustHostKey(byte[] publicKeyBlob);

    String password(String username, boolean retry);

    String[] keyboardInteractive(String name, String instruction, String[] prompts, boolean[] echo);
  }

  public static final class Config {
    public String host;
    public int port = 22;
    public String username;
    /** A saved password to try before asking, or null. */
    public String password;
    /** An OpenSSH or PEM private key, or null. */
    public String privateKey;
    public String passphrase;
    public int cols = 80;
    public int rows = 24;
  }

  private static final int CONNECT_TIMEOUT_MS = 30_000;

  private final Config config;
  private final Events events;
  private final Prompter prompter;
  private final Object lock = new Object();

  private Session session;
  private ChannelShell channel;
  private OutputStream toRemote;
  private volatile boolean closing;
  private boolean closedReported;
  /** A specific reason for the failure, preferred over the library's message. */
  private volatile String failure;

  public SshSession(Config config, Events events, Prompter prompter) {
    this.config = config;
    this.events = events;
    this.prompter = prompter;
  }

  /** Connects on a new thread and returns at once. */
  public void start() {
    Thread thread = new Thread(this::run, "ssh-" + config.host);
    thread.setDaemon(true);
    thread.start();
  }

  private void run() {
    String error = null;
    try {
      JSch jsch = new JSch();
      if (config.privateKey != null && !config.privateKey.isEmpty()) {
        byte[] passphrase =
            config.passphrase == null || config.passphrase.isEmpty()
                ? null
                : config.passphrase.getBytes(StandardCharsets.UTF_8);
        jsch.addIdentity(
            "vault-key", config.privateKey.getBytes(StandardCharsets.UTF_8), null, passphrase);
      }

      Session s = jsch.getSession(config.username, config.host, config.port);
      synchronized (lock) {
        if (closing) return;
        session = s;
      }
      // Our own repository decides, so anything it does not approve is refused.
      s.setHostKeyRepository(new AskingHostKeys());
      s.setConfig("StrictHostKeyChecking", "yes");
      s.setConfig("PreferredAuthentications", "publickey,password,keyboard-interactive");
      if (config.password != null && !config.password.isEmpty()) s.setPassword(config.password.getBytes(StandardCharsets.UTF_8));
      s.setUserInfo(new Asking());
      s.setServerAliveInterval(20_000);
      s.setServerAliveCountMax(3);
      s.connect(CONNECT_TIMEOUT_MS);

      ChannelShell ch = (ChannelShell) s.openChannel("shell");
      int cols;
      int rows;
      synchronized (lock) {
        cols = config.cols;
        rows = config.rows;
      }
      ch.setPtyType("xterm-256color", cols, rows, 0, 0);
      InputStream fromRemote = ch.getInputStream();
      OutputStream out = ch.getOutputStream();
      ch.connect(CONNECT_TIMEOUT_MS);
      synchronized (lock) {
        if (closing) return;
        channel = ch;
        toRemote = out;
        // A resize that arrived while the shell was being opened.
        if (config.cols != cols || config.rows != rows) {
          ch.setPtySize(config.cols, config.rows, 0, 0);
        }
      }
      events.connected();

      byte[] buffer = new byte[16 * 1024];
      int read;
      while ((read = fromRemote.read(buffer)) != -1) {
        if (read > 0) events.data(buffer, read);
      }
    } catch (Exception e) {
      if (!closing) error = failure != null ? failure : describe(e);
    } finally {
      disconnect();
      reportClosed(error);
    }
  }

  public void write(byte[] data) {
    OutputStream out;
    synchronized (lock) {
      out = toRemote;
    }
    if (out == null) return;
    try {
      out.write(data);
      out.flush();
    } catch (Exception e) {
      // The read loop notices a broken connection and reports it.
    }
  }

  public void resize(int cols, int rows) {
    if (cols <= 0 || rows <= 0) return;
    ChannelShell ch;
    synchronized (lock) {
      // Remembered even while still connecting (the screen often changes size
      // then, for instance when the keyboard opens for a password), so the
      // shell starts at the size the terminal has now, not the one it had at
      // the start.
      config.cols = cols;
      config.rows = rows;
      ch = channel;
    }
    if (ch != null) ch.setPtySize(cols, rows, 0, 0);
  }

  /** Ends the session without reporting an error. Safe to call more than once. */
  public void close() {
    closing = true;
    disconnect();
  }

  private void disconnect() {
    Session s;
    ChannelShell ch;
    synchronized (lock) {
      s = session;
      ch = channel;
      session = null;
      channel = null;
      toRemote = null;
    }
    if (ch != null) ch.disconnect();
    if (s != null) s.disconnect();
  }

  private void reportClosed(String error) {
    synchronized (lock) {
      if (closedReported) return;
      closedReported = true;
    }
    events.closed(error);
  }

  private static String describe(Exception e) {
    for (Throwable t = e; t != null; t = t.getCause()) {
      if (t instanceof UnknownHostException) return "Host not found";
      if (t instanceof ConnectException) return "Connection refused";
      if (t instanceof SocketTimeoutException) return "Connection timed out";
    }
    String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    if (message.contains("Auth fail")) return "Authentication failed";
    if (message.contains("Auth cancel")) return "Authentication cancelled";
    if (message.contains("timeout") || message.contains("timed out")) return "Connection timed out";
    if (e instanceof JSchException && message.startsWith("invalid privatekey")) {
      return "The saved key could not be used: " + message;
    }
    return message;
  }

  /** Asks the app about every host key instead of keeping a known-hosts file. */
  private final class AskingHostKeys implements HostKeyRepository {
    @Override
    public int check(String host, byte[] key) {
      if (prompter.trustHostKey(key)) return OK;
      if (failure == null) failure = "Host key was not trusted";
      return CHANGED;
    }

    @Override
    public void add(HostKey hostkey, UserInfo ui) {}

    @Override
    public void remove(String host, String type) {}

    @Override
    public void remove(String host, String type, byte[] key) {}

    @Override
    public String getKnownHostsRepositoryID() {
      return "termterm-vault";
    }

    @Override
    public HostKey[] getHostKey() {
      return new HostKey[0];
    }

    @Override
    public HostKey[] getHostKey(String host, String type) {
      return new HostKey[0];
    }
  }

  private final class Asking implements UserInfo, UIKeyboardInteractive {
    private String password;
    private boolean askedBefore;

    @Override
    public boolean promptPassword(String message) {
      // Reached when there is no saved password, or the last one was refused.
      boolean retry = askedBefore || (config.password != null && !config.password.isEmpty());
      askedBefore = true;
      password = prompter.password(config.username, retry);
      if (password == null) failure = "Authentication cancelled";
      return password != null;
    }

    @Override
    public String getPassword() {
      return password;
    }

    @Override
    public String[] promptKeyboardInteractive(
        String destination, String name, String instruction, String[] prompt, boolean[] echo) {
      if (prompt == null || prompt.length == 0) return new String[0];
      String[] answers = prompter.keyboardInteractive(name, instruction, prompt, echo);
      if (answers == null) failure = "Authentication cancelled";
      return answers;
    }

    @Override
    public boolean promptPassphrase(String message) {
      return false; // the vault supplies the passphrase with the key
    }

    @Override
    public String getPassphrase() {
      return null;
    }

    @Override
    public boolean promptYesNo(String message) {
      return false; // host keys are decided by AskingHostKeys, nothing else is agreed to
    }

    @Override
    public void showMessage(String message) {}
  }
}
