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
    Run start(String user, String password, String key, String passphrase) {
      SshSession.Config c = new SshSession.Config(); c.host = "127.0.0.1"; c.port = port; c.username = user; c.password = password; c.privateKey = key; c.passphrase = passphrase; c.cols = 100; c.rows = 30;
      session = new SshSession(c, new SshSession.Events() {
        public void connected() { connected.countDown(); }
        public void data(byte[] b, int n) { synchronized (out) { out.append(new String(b, 0, n, StandardCharsets.UTF_8)); } }
        public void closed(String e) { error = e; closed.countDown(); }
      }, new SshSession.Prompter() {
        public boolean trustHostKey(byte[] blob) { hostKey = blob; asked.add("hostkey"); if (onHostKey != null) onHostKey.run(); return trust; }
        public String password(String u, boolean retry) { asked.add("password" + (retry ? ":retry" : "")); return passwords.poll(); }
        public String[] keyboardInteractive(String n, String i, String[] p, boolean[] e) { asked.add("kbd:" + n + ":" + p[0].trim() + ":" + e[0]); return kbd == null ? null : new String[] { kbd }; }
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
    r.session.write("exit\r".getBytes()); check("remote exit ends the session cleanly", r.ended() && r.error == null, String.valueOf(r.error));

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

    port = 1; r = new Run().start("dean", "x", null, null);
    check("closed port reports connection refused", r.ended() && "Connection refused".equals(r.error), String.valueOf(r.error));
    System.out.println(failures == 0 ? "ALL PASSED" : failures + " FAILED"); System.exit(failures == 0 ? 0 : 1);
  }
}
