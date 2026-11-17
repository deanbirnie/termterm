package dev.termterm.app.ssh;

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
 * Logs in to a server, through any jump hosts, for a terminal, a port forward
 * or a file browser.
 *
 * <p>Every decision that needs the user (trusting a host key, a password)
 * goes through the {@link SshSession.Prompter}, which blocks the connection
 * thread until it is answered. No credentials are sent before the host key
 * has been accepted, and each server only ever sees its own key.
 *
 * <p>No Android dependencies: compiled and tested on a plain JVM.
 */
public final class SshConnector {

  static final int CONNECT_TIMEOUT_MS = 30_000;

  private final SshSession.Prompter prompter;
  private final Object lock = new Object();
  /** Every SSH session opened: jump hosts first, the target last. */
  private final java.util.List<Session> sessions = new java.util.ArrayList<>();
  private volatile boolean closing;
  /** A specific reason for the failure, preferred over the library's message. */
  private volatile String failure;

  public SshConnector(SshSession.Prompter prompter) {
    this.prompter = prompter;
  }

  public boolean isClosing() {
    return closing;
  }

  /**
   * Logs in to the server {@code c} describes, after the ones it is reached
   * through. Returns null if {@link #close()} was called meanwhile.
   */
  public Session open(SshSession.Config c) throws Exception {
    return open(c, 0);
  }

  private Session open(SshSession.Config c, int hop) throws Exception {
    Session via = c.jump == null ? null : open(c.jump, hop + 1);
    if (c.jump != null && via == null) return null;
    JSch jsch = new JSch();
    if (c.privateKey != null && !c.privateKey.isEmpty()) {
      byte[] passphrase =
          c.passphrase == null || c.passphrase.isEmpty() ? null : c.passphrase.getBytes(StandardCharsets.UTF_8);
      jsch.addIdentity("vault-key", c.privateKey.getBytes(StandardCharsets.UTF_8), null, passphrase);
    }
    Session s = jsch.getSession(c.username, c.host, c.port);
    synchronized (lock) {
      if (closing) return null;
      sessions.add(s);
    }
    if (via != null) s.setProxy(new Through(via));
    // Our own repository decides, so anything it does not approve is refused.
    s.setHostKeyRepository(new AskingHostKeys(hop));
    s.setConfig("StrictHostKeyChecking", "yes");
    s.setConfig("PreferredAuthentications", "publickey,password,keyboard-interactive");
    if (c.password != null && !c.password.isEmpty()) s.setPassword(c.password.getBytes(StandardCharsets.UTF_8));
    s.setUserInfo(new Asking(hop, c));
    s.setServerAliveInterval(Math.max(0, c.keepAliveSeconds) * 1000); // 0 sends none
    s.setServerAliveCountMax(3);
    s.connect(CONNECT_TIMEOUT_MS);
    return s;
  }

  /** Disconnects everything opened, the target first. Safe to call more than once. */
  public void close() {
    closing = true;
    disconnect();
  }

  void disconnect() {
    java.util.List<Session> all;
    synchronized (lock) {
      all = new java.util.ArrayList<>(sessions);
      sessions.clear();
    }
    for (int i = all.size() - 1; i >= 0; i--) all.get(i).disconnect();
  }

  /** What went wrong, in words for the user. */
  public String describe(Exception e) {
    if (failure != null) return failure;
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

  /**
   * Reaches a server through an already connected jump host: a direct-tcpip
   * channel on it stands in for the socket, so nothing listens on the phone.
   */
  private static final class Through implements com.jcraft.jsch.Proxy {
    private final Session via;
    private com.jcraft.jsch.ChannelDirectTCPIP channel;
    private InputStream in;
    private OutputStream out;

    Through(Session via) {
      this.via = via;
    }

    @Override
    public void connect(com.jcraft.jsch.SocketFactory factory, String host, int port, int timeout) throws Exception {
      channel = (com.jcraft.jsch.ChannelDirectTCPIP) via.openChannel("direct-tcpip");
      channel.setHost(host);
      channel.setPort(port);
      in = channel.getInputStream();
      out = channel.getOutputStream();
      channel.connect(timeout);
    }

    @Override
    public InputStream getInputStream() {
      return in;
    }

    @Override
    public OutputStream getOutputStream() {
      return out;
    }

    @Override
    public java.net.Socket getSocket() {
      return null;
    }

    @Override
    public void close() {
      if (channel != null) channel.disconnect();
    }
  }

  /** Asks the app about every host key instead of keeping a known-hosts file. */
  private final class AskingHostKeys implements HostKeyRepository {
    private final int hop;

    AskingHostKeys(int hop) {
      this.hop = hop;
    }

    @Override
    public int check(String host, byte[] key) {
      if (prompter.trustHostKey(hop, key)) return OK;
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
    private final int hop;
    private final SshSession.Config c;
    private String password;
    private boolean askedBefore;

    Asking(int hop, SshSession.Config c) {
      this.hop = hop;
      this.c = c;
    }

    @Override
    public boolean promptPassword(String message) {
      // Reached when there is no saved password, or the last one was refused.
      boolean retry = askedBefore || (c.password != null && !c.password.isEmpty());
      askedBefore = true;
      password = prompter.password(hop, c.username, retry);
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
      String[] answers = prompter.keyboardInteractive(hop, name, instruction, prompt, echo);
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
