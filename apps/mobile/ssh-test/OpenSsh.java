import dev.termterm.app.ssh.SshSession;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * The Android SSH core against a real OpenSSH server (see openssh.cjs):
 * certificate logins, agent forwarding seen from the server, and proxies.
 */
public class OpenSsh {
  static int failures = 0;
  static Path dir;
  static Properties props = new Properties();

  static void check(String name, boolean ok, String detail) {
    System.out.println((ok ? "  ok   " : "  FAIL ") + name + (ok ? "" : "  -> " + detail));
    if (!ok) failures++;
  }

  static String read(String file) throws Exception {
    return new String(Files.readAllBytes(dir.resolve(file)), StandardCharsets.UTF_8).trim();
  }

  static final SshSession.Prompter TRUSTING = new SshSession.Prompter() {
    public boolean trustHostKey(int hop, byte[] blob) { return true; }
    public String password(int hop, String u, boolean retry) { return null; }
    public String[] keyboardInteractive(int hop, String n, String i, String[] p, boolean[] e) { return null; }
  };

  static SshSession.Config cfg(String key) throws Exception {
    SshSession.Config c = new SshSession.Config();
    c.host = "127.0.0.1";
    c.port = Integer.parseInt(props.getProperty("port"));
    c.username = props.getProperty("user");
    c.privateKey = read(key);
    c.certificate = read(key + "-cert.pub");
    return c;
  }

  /** A shell session; output collected, so commands can be run and their results waited for. */
  static class Shell {
    final StringBuilder out = new StringBuilder();
    final CountDownLatch connected = new CountDownLatch(1);
    final CountDownLatch closed = new CountDownLatch(1);
    volatile String error;
    SshSession session;

    Shell(SshSession.Config c) {
      session = new SshSession(c, new SshSession.Events() {
        public void connected() { connected.countDown(); }
        public void data(byte[] b, int n) { synchronized (out) { out.append(new String(b, 0, n, StandardCharsets.UTF_8)); } }
        public void closed(String e) { error = e; closed.countDown(); connected.countDown(); }
      }, TRUSTING);
      session.start();
    }

    boolean up() throws Exception { return connected.await(20, TimeUnit.SECONDS) && error == null && closed.getCount() == 1; }

    /** Runs a command; true once `expect` shows up in the output. */
    boolean run(String command, String expect) throws Exception {
      session.write((command + "\n").getBytes(StandardCharsets.UTF_8));
      for (int i = 0; i < 300; i++) {
        synchronized (out) { if (out.indexOf(expect) >= 0) return true; }
        Thread.sleep(50);
      }
      return false;
    }

    String output() { synchronized (out) { return out.toString(); } }
  }

  public static void main(String[] a) throws Exception {
    dir = Paths.get(a[0]);
    try (java.io.Reader r = Files.newBufferedReader(dir.resolve("openssh.properties"))) { props.load(r); }

    for (String key : new String[] { "ed", "rsa", "ec" }) {
      Shell s = new Shell(cfg(key));
      check(key + " certificate logs in to OpenSSH (which trusts only the CA)", s.up() && s.run("echo cert-$((6*7))", "cert-42"), s.error + " " + s.output());
      s.session.close();
    }

    SshSession.Config plain = cfg("ed");
    plain.certificate = null;
    Shell refused = new Shell(plain);
    check("the key without its certificate is refused there", !refused.up() && "Authentication failed".equals(refused.error), String.valueOf(refused.error));

    // Agent forwarding: the server sees the vault keys, and logs in onward with a certificate.
    SshSession.Config fwd = cfg("ed");
    fwd.agentKeys = new ArrayList<>();
    for (String key : new String[] { "rsa", "ec" }) {
      SshSession.AgentKey k = new SshSession.AgentKey();
      k.name = key;
      k.privateKey = read(key);
      k.certificate = key.equals("rsa") ? read("rsa-cert.pub") : null;
      fwd.agentKeys.add(k);
    }
    Shell agent = new Shell(fwd);
    boolean listed = agent.up() && agent.run("ssh-add -L; echo listed-done", "listed-done");
    String out = agent.output();
    check("the forwarded agent lists the vault keys and the certificate (ssh-add -L)",
        listed && out.contains(read("rsa.pub").split(" ")[1]) && out.contains(read("rsa-cert.pub").split(" ")[1]) && out.contains(read("ec.pub").split(" ")[1]),
        out);
    String onward = "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p " + props.getProperty("port") + " " + props.getProperty("user") + "@127.0.0.1 echo onward-$((6*7))";
    check("ssh on the server logs in onward with the RSA certificate through the forwarded agent", agent.run(onward, "onward-42"), agent.output());
    agent.session.close();

    Shell noAgent = new Shell(cfg("ed"));
    check("without agent forwarding the server has no agent", noAgent.up() && noAgent.run("ssh-add -L; echo none-done", "none-done") && !noAgent.output().contains(read("rsa.pub").split(" ")[1]), noAgent.output());
    noAgent.session.close();

    // Proxies.
    for (String kind : new String[] { "socks5", "http" }) {
      SshSession.Config c = cfg("ed");
      c.proxy = new SshSession.Proxy();
      c.proxy.kind = kind;
      c.proxy.host = "127.0.0.1";
      c.proxy.port = Integer.parseInt(props.getProperty(kind.equals("http") ? "httpPort" : "socksPort"));
      c.proxy.username = "proxy-user";
      c.proxy.password = "proxy-pass";
      Shell s = new Shell(c);
      check("logs in through the " + kind + " proxy", s.up() && s.run("echo via-$((6*7))", "via-42"), s.error + " " + s.output());
      s.session.close();
      c.proxy.password = "wrong";
      Shell bad = new Shell(c);
      check("a wrong " + kind + " proxy password is reported", !bad.up() && bad.error != null && bad.error.toLowerCase().contains("proxy"), String.valueOf(bad.error));
    }

    System.out.println(failures == 0 ? "OPENSSH PASSED" : failures + " FAILED");
    System.exit(failures == 0 ? 0 : 1);
  }
}
