import dev.termterm.app.ssh.FileSession;
import dev.termterm.app.ssh.ForwardSession;
import dev.termterm.app.ssh.SshKeys;
import dev.termterm.app.ssh.SshSession;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

public class Smoke {
  static int port; static int failures = 0;
  static void check(String name, boolean ok, String detail) { System.out.println((ok ? "  ok   " : "  FAIL ") + name + (ok ? "" : "  -> " + detail)); if (!ok) failures++; }

  static class Run {
    StringBuilder out = new StringBuilder(); CountDownLatch closed = new CountDownLatch(1); CountDownLatch connected = new CountDownLatch(1);
    volatile String error; List<String> asked = new ArrayList<>(); volatile byte[] hostKey; SshSession session;
    boolean trust = true; Deque<String> passwords = new ArrayDeque<>(); String kbd; Runnable onHostKey;
    SshSession.Config jump; Map<String, String> env = new LinkedHashMap<>(); int keepAlive = 20;
    Run start(String user, String password, String key, String passphrase) {
      SshSession.Config c = new SshSession.Config(); c.host = "127.0.0.1"; c.port = port; c.username = user; c.password = password; c.privateKey = key; c.passphrase = passphrase; c.cols = 100; c.rows = 30; c.jump = jump; c.env = env; c.keepAliveSeconds = keepAlive;
      session = new SshSession(c, new SshSession.Events() {
        public void connected() { connected.countDown(); }
        public void data(byte[] b, int n) { synchronized (out) { out.append(new String(b, 0, n, StandardCharsets.UTF_8)); } }
        public void closed(String e) { error = e; closed.countDown(); }
      }, new SshSession.Prompter() {
        public boolean trustHostKey(int hop, byte[] blob) { hostKey = blob; asked.add("hostkey" + (hop > 0 ? "@" + hop : "")); if (onHostKey != null) onHostKey.run(); return trust; }
        public String password(int hop, String u, boolean retry) { asked.add("password" + (retry ? ":retry" : "") + (hop > 0 ? "@" + hop : "")); return passwords.poll(); }
        public String[] keyboardInteractive(int hop, String n, String i, String[] p, boolean[] e) { asked.add("kbd:" + n + ":" + p[0].trim() + ":" + e[0]); return kbd == null ? null : new String[] { kbd }; }
      });
      session.start(); return this;
    }
    boolean waitFor(String text) throws Exception { for (int i = 0; i < 100; i++) { synchronized (out) { if (out.indexOf(text) >= 0) return true; } Thread.sleep(50); } return false; }
    boolean ended() throws Exception { return closed.await(15, TimeUnit.SECONDS); }
  }

  public static void main(String[] a) throws Exception {
    port = Integer.parseInt(a[0]); Path authorized = Paths.get(a[1]);

    Run r = new Run().start("dean", "pw-ok", null, null);
    check("saved password logs in", r.connected.await(15, TimeUnit.SECONDS), String.valueOf(r.error));
    check("host key was asked about first, and nothing else", r.asked.equals(List.of("hostkey")), r.asked.toString());
    check("host key blob looks like ssh-ed25519", r.hostKey != null && new String(r.hostKey, 4, 11).equals("ssh-ed25519"), "");
    check("shell output arrives with the requested size", r.waitFor("welcome 100x30"), r.out.toString());
    r.session.write("echo hi\r".getBytes()); check("input reaches the shell", r.waitFor("ran:echo hi"), r.out.toString());
    r.session.resize(120, 40); r.session.write("x\r".getBytes()); check("resize is applied", r.waitFor("size:120x40"), r.out.toString());
    // A server that does not answer window-change (as RFC 4254 allows): resizing must not hold up the caller or the input.
    Run q = new Run().start("quiet", "pw-ok", null, null);
    check("quiet server logs in", q.connected.await(15, TimeUnit.SECONDS) && q.waitFor("welcome"), String.valueOf(q.error));
    long t0 = System.nanoTime(); q.session.resize(90, 20); long took = (System.nanoTime() - t0) / 1_000_000;
    check("resizing returns at once even when the server does not answer", took < 500, took + " ms");
    q.session.write("y\r".getBytes());
    check("input after a resize reaches the shell at once", q.waitFor("ran:y size:90x20"), q.out.toString());
    q.session.close();
    r.session.write("exit\r".getBytes()); check("remote exit ends the session cleanly", r.ended() && r.error == null, String.valueOf(r.error));

    r = new Run(); r.env.put("LANG", "en_GB.UTF-8"); r.env.put("APP_ENV", "staging"); r.keepAlive = 0; r.start("dean", "pw-ok", null, null);
    check("environment variables reach the server, keep-alives off is accepted",
        r.waitFor("welcome") && r.out.indexOf("LANG=en_GB.UTF-8") >= 0 && r.out.indexOf("APP_ENV=staging") >= 0, r.out + " " + r.error);
    r.session.close(); r.ended();

    // Through a jump host (the same test server, reached through itself).
    r = new Run(); r.jump = new SshSession.Config(); r.jump.host = "127.0.0.1"; r.jump.port = port; r.jump.username = "dean"; r.passwords.add("pw-ok");
    r.start("dean", "pw-ok", null, null);
    check("connects through a jump host", r.connected.await(15, TimeUnit.SECONDS) && r.waitFor("welcome"), r.asked + " " + r.error);
    check("each hop's host key and login asked about on its own, the jump host first", r.asked.equals(List.of("hostkey@1", "password@1", "hostkey")), r.asked.toString());
    r.session.write("exit\r".getBytes()); check("a session through a jump host ends cleanly", r.ended() && r.error == null, String.valueOf(r.error));

    r = new Run().start("dean", "pw-ok", null, null);
    check("logs in again", r.connected.await(15, TimeUnit.SECONDS), String.valueOf(r.error));
    r.session.write("drop\r".getBytes());
    check("a connection cut off without the shell ending reports Connection lost", r.ended() && "Connection lost".equals(r.error), String.valueOf(r.error));

    final Run early = new Run();
    early.onHostKey = () -> early.session.resize(132, 50); // e.g. the keyboard opened during a prompt
    early.start("dean", "pw-ok", null, null);
    check("a resize sent while connecting sets the starting size", early.waitFor("welcome 132x50"), early.out.toString());
    early.session.close(); early.ended();

    r = new Run(); r.trust = false; r.start("dean", "pw-ok", null, null);
    check("untrusted host key refuses the connection", r.ended() && "Host key was not trusted".equals(r.error), String.valueOf(r.error));
    check("no credential prompt after refusing the host key", r.asked.equals(List.of("hostkey")), r.asked.toString());

    r = new Run(); r.passwords.add("pw-ok"); r.start("dean", null, null, null);
    check("no saved password: asks, then logs in", r.connected.await(15, TimeUnit.SECONDS) && r.asked.equals(List.of("hostkey", "password")), r.asked + " " + r.error);
    r.session.close(); check("close() ends without an error", r.ended() && r.error == null, String.valueOf(r.error));

    r = new Run(); r.passwords.add("pw-ok"); r.start("dean", "wrong-saved", null, null);
    check("wrong saved password: asks again as a retry", r.connected.await(15, TimeUnit.SECONDS) && r.asked.equals(List.of("hostkey", "password:retry")), r.asked + " " + r.error);
    r.session.close(); r.ended();

    r = new Run().start("dean", null, null, null);
    check("cancelling the password prompt", r.ended() && "Authentication cancelled".equals(r.error), String.valueOf(r.error));

    r = new Run(); r.passwords.addAll(List.of("bad1", "bad2", "bad3", "bad4", "bad5", "bad6", "bad7")); r.start("dean", null, null, null);
    check("repeated wrong passwords end as authentication failed", r.ended() && "Authentication failed".equals(r.error), r.error + " " + r.asked);

    r = new Run(); r.kbd = "kbd-ok"; r.start("kbd", null, null, null);
    check("keyboard-interactive login", r.connected.await(15, TimeUnit.SECONDS) && r.asked.contains("kbd:Second factor:Code::true"), r.asked + " " + r.error);
    r.session.close(); r.ended();

    for (String type : new String[] { "ed25519", "rsa" }) {
      SshKeys.Result k = SshKeys.generate(type);
      String line = k.keyType + " " + Base64.getEncoder().encodeToString(k.publicKeyBlob) + " test";
      Files.writeString(authorized, line);
      Files.writeString(authorized.resolveSibling("generated-" + type + ".key"), k.privateKey);
      check(type + " key generated in OpenSSH format", k.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----") && k.keyType.equals(type.equals("rsa") ? "ssh-rsa" : "ssh-ed25519"), k.keyType);
      SshKeys.Result again = SshKeys.inspect(k.privateKey, null);
      check(type + " key reads back with the same public half", Arrays.equals(again.publicKeyBlob, k.publicKeyBlob), "");
      r = new Run().start("dean", null, k.privateKey, null);
      check(type + " key logs in with no prompts", r.connected.await(20, TimeUnit.SECONDS) && r.asked.equals(List.of("hostkey")), r.asked + " " + r.error);
      r.session.close(); r.ended();
    }

    if (a.length > 2) {
      String enc = Files.readString(Paths.get(a[2]));
      try { SshKeys.inspect(enc, null); check("encrypted key without passphrase is refused", false, "accepted"); } catch (SshKeys.KeyException e) { check("encrypted key without passphrase is refused", e.getMessage().contains("encrypted"), e.getMessage()); }
      try { SshKeys.inspect(enc, "nope"); check("wrong passphrase is refused", false, "accepted"); } catch (SshKeys.KeyException e) { check("wrong passphrase is refused", e.getMessage().contains("Wrong passphrase"), e.getMessage()); }
      SshKeys.Result k = SshKeys.inspect(enc, "secret-pass");
      Files.writeString(authorized, k.keyType + " " + Base64.getEncoder().encodeToString(k.publicKeyBlob) + " test");
      r = new Run().start("dean", null, enc, "secret-pass");
      check("desktop-made encrypted key logs in with its passphrase", r.connected.await(20, TimeUnit.SECONDS), r.asked + " " + r.error);
      r.session.close(); r.ended();
    }
    try { SshKeys.inspect("not a key", null); check("garbage is refused", false, "accepted"); } catch (SshKeys.KeyException e) { check("garbage is refused", true, ""); }

    forwardsAndFiles(a.length > 3 ? Paths.get(a[3]) : null);

    port = 1; r = new Run().start("dean", "x", null, null);
    check("closed port reports connection refused", r.ended() && "Connection refused".equals(r.error), String.valueOf(r.error));
    System.out.println(failures == 0 ? "ALL PASSED" : failures + " FAILED"); System.exit(failures == 0 ? 0 : 1);
  }

  // ---- port forwards and SFTP ----

  static final SshSession.Prompter TRUSTING = new SshSession.Prompter() {
    public boolean trustHostKey(int hop, byte[] blob) { return true; }
    public String password(int hop, String u, boolean retry) { return null; }
    public String[] keyboardInteractive(int hop, String n, String i, String[] p, boolean[] e) { return null; }
  };
  static SshSession.Config cfg() { SshSession.Config c = new SshSession.Config(); c.host = "127.0.0.1"; c.port = port; c.username = "dean"; c.password = "pw-ok"; return c; }

  /** A TCP echo server: every byte sent comes back. */
  static java.net.ServerSocket echo() throws Exception {
    java.net.ServerSocket ss = new java.net.ServerSocket(0, 50, java.net.InetAddress.getLoopbackAddress());
    Thread t = new Thread(() -> { while (true) { try { java.net.Socket s = ss.accept(); new Thread(() -> { try { s.getInputStream().transferTo(s.getOutputStream()); s.close(); } catch (Exception e) {} }).start(); } catch (Exception e) { return; } } });
    t.setDaemon(true); t.start(); return ss;
  }
  static int freePort() throws Exception { try (java.net.ServerSocket ss = new java.net.ServerSocket(0)) { return ss.getLocalPort(); } }

  static class Fwd implements ForwardSession.Events {
    CountDownLatch active = new CountDownLatch(1), closed = new CountDownLatch(1); volatile String error = "not closed"; List<Integer> counts = Collections.synchronizedList(new ArrayList<>());
    public void active() { active.countDown(); }
    public void connections(int n) { counts.add(n); }
    public void closed(String e) { error = e; closed.countDown(); }
  }
  static ForwardSession forward(String kind, String bindHost, int bindPort, String destHost, int destPort, Fwd events) {
    ForwardSession.Spec spec = new ForwardSession.Spec(); spec.kind = kind; spec.bindHost = bindHost; spec.bindPort = bindPort; spec.destHost = destHost; spec.destPort = destPort;
    ForwardSession f = new ForwardSession(cfg(), spec, events, TRUSTING); f.start(); return f;
  }
  static String roundTrip(java.net.Socket s, String text) throws Exception {
    s.setSoTimeout(10000); s.getOutputStream().write(text.getBytes()); s.getOutputStream().flush();
    byte[] buf = new byte[text.length()]; new java.io.DataInputStream(s.getInputStream()).readFully(buf); return new String(buf);
  }

  static void forwardsAndFiles(Path filesRoot) throws Exception {
    java.net.ServerSocket target = echo();

    int local = freePort(); Fwd fl = new Fwd();
    ForwardSession f = forward("local", "127.0.0.1", local, "127.0.0.1", target.getLocalPort(), fl);
    check("local forward starts listening", fl.active.await(15, TimeUnit.SECONDS), fl.error);
    try (java.net.Socket s = new java.net.Socket("127.0.0.1", local)) {
      check("local forward carries traffic to the destination", "ping-local".equals(roundTrip(s, "ping-local")), "");
      check("local forward counts its open connection", fl.counts.contains(1), fl.counts.toString());
    }
    Fwd busy = new Fwd(); forward("local", "127.0.0.1", local, "127.0.0.1", target.getLocalPort(), busy);
    check("a port already in use is reported as such", busy.closed.await(15, TimeUnit.SECONDS) && busy.error != null && busy.error.contains("already in use"), busy.error);
    f.stop();
    check("stopping a forward reports no error", fl.closed.await(5, TimeUnit.SECONDS) && fl.error == null, fl.error);
    boolean freed = false; for (int i = 0; i < 20 && !freed; i++) { try (java.net.ServerSocket ss = new java.net.ServerSocket(local, 50, java.net.InetAddress.getLoopbackAddress())) { freed = true; } catch (Exception e) { Thread.sleep(100); } }
    check("a stopped forward frees its port", freed, "");

    int socks = freePort(); Fwd fd = new Fwd();
    ForwardSession d = forward("dynamic", "127.0.0.1", socks, null, 0, fd);
    check("SOCKS proxy starts listening", fd.active.await(15, TimeUnit.SECONDS), fd.error);
    try (java.net.Socket s = new java.net.Socket("127.0.0.1", socks)) {
      s.setSoTimeout(10000);
      java.io.OutputStream o = s.getOutputStream(); java.io.DataInputStream in = new java.io.DataInputStream(s.getInputStream());
      o.write(new byte[] { 5, 1, 0 }); byte[] greet = new byte[2]; in.readFully(greet);
      byte[] host = "localhost".getBytes(); int p = target.getLocalPort();
      java.io.ByteArrayOutputStream req = new java.io.ByteArrayOutputStream(); req.write(new byte[] { 5, 1, 0, 3, (byte) host.length }); req.write(host); req.write(p >> 8); req.write(p & 255);
      o.write(req.toByteArray()); byte[] reply = new byte[10]; in.readFully(reply);
      check("SOCKS proxy accepts a CONNECT by name", greet[1] == 0 && reply[1] == 0, Arrays.toString(reply));
      check("SOCKS proxy carries traffic through the server", "ping-socks".equals(roundTrip(s, "ping-socks")), "");
    }
    d.stop();

    int remote = freePort(); Fwd fr = new Fwd();
    ForwardSession rf = forward("remote", "127.0.0.1", remote, "127.0.0.1", target.getLocalPort(), fr);
    check("remote forward is accepted by the server", fr.active.await(15, TimeUnit.SECONDS), fr.error);
    try (java.net.Socket s = new java.net.Socket("127.0.0.1", remote)) {
      check("remote forward carries traffic back to this side", "ping-remote".equals(roundTrip(s, "ping-remote")), "");
    }
    rf.stop();
    check("stopping a remote forward reports no error", fr.closed.await(5, TimeUnit.SECONDS) && fr.error == null, fr.error);
    target.close();

    if (filesRoot == null) return;
    FileSession files = new FileSession(cfg(), TRUSTING);
    String home = files.open();
    check("SFTP opens in the home folder", "/home/dean".equals(home), home);
    FileSession.Listing l = files.list(home);
    check("folders are listed first, then files", l.entries.size() == 2 && l.entries.get(0).name.equals("docs") && l.entries.get(0).type.equals("dir") && l.entries.get(1).name.equals("notes.txt") && l.parent.equals("/home"), describe(l));
    java.io.ByteArrayOutputStream got = new java.io.ByteArrayOutputStream();
    files.download(home + "/notes.txt", got, null);
    check("a file downloads intact", got.toString().equals("remote notes\n"), got.toString());
    byte[] big = new byte[300_000]; new Random(7).nextBytes(big); long[] seen = { 0 };
    files.upload(new java.io.ByteArrayInputStream(big), home + "/docs", "photo.jpg", (done) -> { seen[0] = done; return true; });
    check("a file uploads intact, with progress", Arrays.equals(Files.readAllBytes(filesRoot.resolve("home/dean/docs/photo.jpg")), big) && seen[0] == big.length, seen[0] + "");
    try { files.upload(new java.io.ByteArrayInputStream(new byte[1]), home + "/docs", "photo.jpg", null); check("an upload never overwrites", false, "overwrote"); }
    catch (Exception e) { check("an upload never overwrites", e.getMessage().contains("already there") && Files.size(filesRoot.resolve("home/dean/docs/photo.jpg")) == big.length, e.getMessage()); }
    java.nio.file.Path notes = filesRoot.resolve("home/dean/notes.txt");
    Files.setPosixFilePermissions(notes, java.nio.file.attribute.PosixFilePermissions.fromString("rw-r--r--"));
    l = files.list(home);
    check("listings carry permissions", l.entries.get(1).mode == 0644, Integer.toOctalString(l.entries.get(1).mode));
    files.chmod(home + "/notes.txt", 0750);
    check("chmod sets permissions", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(notes)).equals("rwxr-x---"), "");
    FileSession.Text t = files.readText(home + "/notes.txt");
    check("a text file reads for editing", t.text.equals("remote notes\n") && t.size == 13, t.text);
    FileSession.Text after = files.writeText(home + "/notes.txt", "héllo edited\n", t.modified, t.size);
    check("an edit saves in place, keeping permissions", Files.readString(notes).equals("héllo edited\n") && after.size == 14
        && java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(notes)).equals("rwxr-x---"), Files.readString(notes));
    Files.writeString(notes, "changed by someone else\n");
    try { files.writeText(home + "/notes.txt", "mine\n", after.modified, after.size); check("a save over a changed file is refused", false, "saved"); }
    catch (Exception e) { check("a save over a changed file is refused", e.getMessage().contains("changed on the server") && Files.readString(notes).startsWith("changed"), e.getMessage()); }
    files.writeText(home + "/notes.txt", "mine\n", -1, -1);
    check("overwriting on purpose saves", Files.readString(notes).equals("mine\n"), "");
    Files.write(filesRoot.resolve("home/dean/blob.bin"), new byte[] { 0x7f, 'E', 'L', 'F', 0, 1 });
    try { files.readText(home + "/blob.bin"); check("binary files are refused for editing", false, "read"); }
    catch (Exception e) { check("binary files are refused for editing", e.getMessage().contains("binary"), e.getMessage()); }
    Files.write(filesRoot.resolve("home/dean/latin1.txt"), new byte[] { 'c', 'a', 'f', (byte) 0xe9 });
    try { files.readText(home + "/latin1.txt"); check("non-UTF-8 files are refused for editing", false, "read"); }
    catch (Exception e) { check("non-UTF-8 files are refused for editing", e.getMessage().contains("UTF-8"), e.getMessage()); }
    files.mkdir(home + "/docs/new");
    files.rename(home + "/docs/new", home + "/docs/renamed");
    check("folders can be made and renamed", Files.isDirectory(filesRoot.resolve("home/dean/docs/renamed")), "");
    files.delete(home + "/docs");
    check("a folder is deleted with everything in it", !Files.exists(filesRoot.resolve("home/dean/docs")), "");
    try { files.delete("/"); check("deleting / is refused", false, "deleted"); } catch (Exception e) { check("deleting / is refused", true, ""); }
    files.close();
  }
  static String describe(FileSession.Listing l) { StringBuilder b = new StringBuilder(l.path + " parent " + l.parent + ":"); for (FileSession.Entry e : l.entries) b.append(' ').append(e.name).append('/').append(e.type); return b.toString(); }
}
