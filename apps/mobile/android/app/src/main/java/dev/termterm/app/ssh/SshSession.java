package dev.termterm.app.ssh;

import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.Session;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * One SSH connection with an interactive shell. Logging in (jump hosts,
 * prompts) is {@link SshConnector}'s job.
 *
 * <p>This class has no Android dependencies, so it can be compiled and tested
 * on any JVM. {@code SshPlugin} wraps it for the WebView.
 */
public final class SshSession {

  /** Callbacks for what the connection produces. Called on the connection thread. */
  public interface Events {
    void connected();

    void data(byte[] buffer, int length);

    /** Called exactly once. {@code error} is null for a normal end. */
    void closed(String error);
  }

  /**
   * Questions for the user. Each call blocks until answered; null or false
   * means "cancel". {@code hop} says which server asks: 0 is the target, 1
   * the jump host it is reached through, 2 that one's jump host, and so on.
   */
  public interface Prompter {
    boolean trustHostKey(int hop, byte[] publicKeyBlob);

    String password(int hop, String username, boolean retry);

    String[] keyboardInteractive(int hop, String name, String instruction, String[] prompts, boolean[] echo);
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
    /** The server to connect through first (ssh's ProxyJump), or null to connect directly. */
    public Config jump;
    /** Seconds between keep-alive messages; 0 sends none. */
    public int keepAliveSeconds = 20;
    /** Environment variables for the shell (servers apply those their AcceptEnv allows). */
    public java.util.Map<String, String> env = new java.util.LinkedHashMap<>();
    public int cols = 80;
    public int rows = 24;
  }

  private final Config config;
  private final Events events;
  private final SshConnector connector;
  private final Object lock = new Object();

  private ChannelShell channel;
  private OutputStream toRemote;
  private boolean closedReported;

  public SshSession(Config config, Events events, Prompter prompter) {
    this.config = config;
    this.events = events;
    this.connector = new SshConnector(prompter);
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
      Session s = connector.open(config);
      if (s == null) return;

      ChannelShell ch = (ChannelShell) s.openChannel("shell");
      int cols;
      int rows;
      synchronized (lock) {
        cols = config.cols;
        rows = config.rows;
      }
      ch.setPtyType("xterm-256color", cols, rows, 0, 0);
      for (java.util.Map.Entry<String, String> e : config.env.entrySet()) ch.setEnv(e.getKey(), e.getValue());
      InputStream fromRemote = ch.getInputStream();
      OutputStream out = ch.getOutputStream();
      ch.connect(SshConnector.CONNECT_TIMEOUT_MS);
      synchronized (lock) {
        if (connector.isClosing()) return;
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
      // A shell the user left (exit, logout) reports its exit status; one that
      // just stops was cut off (the server stopped answering keep-alives, the
      // network went away), and the app reconnects it.
      if (!connector.isClosing() && ch.getExitStatus() == -1) error = LOST;
    } catch (Exception e) {
      if (!connector.isClosing()) error = connector.describe(e);
    } finally {
      disconnect();
      reportClosed(error);
    }
  }

  /**
   * Sends typed input to the shell. Throws if it could not be sent (not
   * connected yet, or the connection failed); the read loop reports a broken
   * connection to the interface, so callers only need to log this.
   */
  public void write(byte[] data) throws java.io.IOException {
    OutputStream out;
    synchronized (lock) {
      out = toRemote;
    }
    if (out == null) throw new java.io.IOException("Not connected yet");
    out.write(data);
    out.flush();
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
    connector.close();
    disconnect();
  }

  private void disconnect() {
    ChannelShell ch;
    synchronized (lock) {
      ch = channel;
      channel = null;
      toRemote = null;
    }
    if (ch != null) ch.disconnect();
    connector.disconnect();
  }

  private void reportClosed(String error) {
    synchronized (lock) {
      if (closedReported) return;
      closedReported = true;
    }
    events.closed(error);
  }

  /** A connection that was working and stopped without the shell ending. */
  public static final String LOST = "Connection lost";
}
