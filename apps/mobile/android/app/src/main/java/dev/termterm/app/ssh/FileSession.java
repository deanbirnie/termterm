package dev.termterm.app.ssh;

import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SftpATTRS;
import com.jcraft.jsch.SftpException;
import com.jcraft.jsch.SftpProgressMonitor;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Vector;

/**
 * One SFTP connection for the phone's file browser: listing, folders,
 * renaming, deleting, and copying a file to or from a stream (Android's file
 * picker supplies those). Copies never overwrite: an existing name stops them.
 *
 * <p>Calls block, so the plugin runs them off the main thread; they are
 * serialised here because one SFTP channel handles one request at a time.
 *
 * <p>No Android dependencies: compiled and tested on a plain JVM.
 */
public final class FileSession {

  public static final class Entry {
    public String name;
    public String path;
    /** "dir", "file", "link" or "other". */
    public String type;
    public long size;
    /** ms since 1970 */
    public long modified;
    /** Permission bits, such as 0755. */
    public int mode;
  }

  /** A file read to edit, and its state then (to notice changes before saving). */
  public static final class Text {
    public String text;
    /** ms since 1970 */
    public long modified;
    public long size;
  }

  static final int MAX_EDIT_BYTES = 1024 * 1024;
  static final String CHANGED_ON_SERVER = "The file changed on the server since you opened it.";

  public static final class Listing {
    public String path;
    /** null at the top */
    public String parent;
    public List<Entry> entries = new ArrayList<>();
  }

  /** Bytes copied so far; return false to stop the copy. */
  public interface Progress {
    boolean copied(long done);
  }

  private final SshSession.Config config;
  private final SshConnector connector;
  private ChannelSftp sftp;
  private String home;

  public FileSession(SshSession.Config config, SshSession.Prompter prompter) {
    this.config = config;
    this.connector = new SshConnector(prompter);
  }

  /** Logs in and opens SFTP. Returns the home folder. Blocks. */
  public synchronized String open() throws Exception {
    try {
      Session s = connector.open(config);
      if (s == null) throw new Exception("Closed");
      ChannelSftp ch = (ChannelSftp) s.openChannel("sftp");
      ch.connect(SshConnector.CONNECT_TIMEOUT_MS);
      sftp = ch;
      home = ch.realpath(".");
      return home;
    } catch (Exception e) {
      connector.close();
      throw new Exception(connector.describe(e), e);
    }
  }

  public void close() {
    ChannelSftp ch = sftp;
    if (ch != null) ch.disconnect();
    connector.close();
  }

  private ChannelSftp channel() throws Exception {
    if (sftp == null || !sftp.isConnected()) throw new Exception("Not connected");
    return sftp;
  }

  public synchronized Listing list(String path) throws Exception {
    ChannelSftp ch = channel();
    String at = ch.realpath(path == null || path.isEmpty() ? home : path);
    Listing out = new Listing();
    out.path = at;
    out.parent = "/".equals(at) ? null : parentOf(at);
    @SuppressWarnings("unchecked")
    Vector<ChannelSftp.LsEntry> all = ch.ls(at);
    for (ChannelSftp.LsEntry e : all) {
      String name = e.getFilename();
      if (".".equals(name) || "..".equals(name)) continue;
      Entry entry = new Entry();
      entry.name = name;
      entry.path = join(at, name);
      SftpATTRS a = e.getAttrs();
      entry.type = a.isDir() ? "dir" : a.isLink() ? "link" : a.isReg() ? "file" : "other";
      if (a.isLink()) {
        // A link to a folder opens like a folder.
        try {
          entry.type = ch.stat(entry.path).isDir() ? "dir" : "file";
        } catch (SftpException broken) {
          entry.type = "link";
        }
      }
      entry.size = a.getSize();
      entry.modified = a.getMTime() * 1000L;
      entry.mode = a.getPermissions() & 07777;
      out.entries.add(entry);
    }
    out.entries.sort(
        (x, y) -> {
          int dirs = Boolean.compare(!"dir".equals(x.type), !"dir".equals(y.type));
          return dirs != 0 ? dirs : x.name.compareToIgnoreCase(y.name);
        });
    return out;
  }

  public synchronized void mkdir(String path) throws Exception {
    channel().mkdir(path);
  }

  public synchronized void rename(String from, String to) throws Exception {
    if (exists(to)) throw new Exception("\"" + nameOf(to) + "\" is already there");
    channel().rename(from, to);
  }

  /** Removes a file, or a folder with everything in it. */
  public synchronized void delete(String path) throws Exception {
    if (path == null || path.isEmpty() || "/".equals(path)) throw new Exception("Refusing to delete /");
    remove(channel(), path);
  }

  private static void remove(ChannelSftp ch, String path) throws SftpException {
    SftpATTRS a = ch.lstat(path);
    if (a.isDir()) {
      @SuppressWarnings("unchecked")
      Vector<ChannelSftp.LsEntry> all = ch.ls(path);
      for (ChannelSftp.LsEntry e : all) {
        String name = e.getFilename();
        if (!".".equals(name) && !"..".equals(name)) remove(ch, join(path, name));
      }
      ch.rmdir(path);
    } else {
      ch.rm(path);
    }
  }

  /** Sets a file's permission bits, as chmod does. */
  public synchronized void chmod(String path, int mode) throws Exception {
    if (mode < 0 || mode > 07777) throw new Exception("Not a valid permission");
    channel().chmod(mode, path);
  }

  /** A server file as text, to edit: UTF-8 only, up to 1 MB. */
  public synchronized Text readText(String path) throws Exception {
    ChannelSftp ch = channel();
    SftpATTRS a = ch.stat(path);
    if (!a.isReg()) throw new Exception("Only files can be edited");
    if (a.getSize() > MAX_EDIT_BYTES) throw new Exception("This file is too large to edit here (over 1 MB). Download it instead.");
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    ch.get(path, bytes);
    Text t = new Text();
    t.text = decode(bytes.toByteArray());
    t.modified = a.getMTime() * 1000L;
    t.size = a.getSize();
    return t;
  }

  /**
   * Saves text over a file, into the existing file so its permissions stay.
   * With {@code expectedModified} at or above 0, refuses if the file is no
   * longer as it was when read.
   */
  public synchronized Text writeText(String path, String text, long expectedModified, long expectedSize) throws Exception {
    ChannelSftp ch = channel();
    byte[] data = text.getBytes(StandardCharsets.UTF_8);
    if (data.length > MAX_EDIT_BYTES) throw new Exception("The text is too large to save here (over 1 MB)");
    if (expectedModified >= 0) {
      SftpATTRS now = ch.stat(path);
      if (now.getMTime() * 1000L != expectedModified || now.getSize() != expectedSize) throw new Exception(CHANGED_ON_SERVER);
    }
    ch.put(new ByteArrayInputStream(data), path, ChannelSftp.OVERWRITE);
    SftpATTRS after = ch.stat(path);
    Text t = new Text();
    t.modified = after.getMTime() * 1000L;
    t.size = after.getSize();
    return t;
  }

  /** UTF-8 text, or an error saying why the bytes cannot be edited as text. */
  static String decode(byte[] bytes) throws Exception {
    for (int i = 0; i < Math.min(bytes.length, 8192); i++) {
      if (bytes[i] == 0) throw new Exception("This looks like a binary file, which cannot be edited here.");
    }
    try {
      return StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes))
          .toString();
    } catch (CharacterCodingException e) {
      throw new Exception("This file is not UTF-8 text, so it cannot be edited here without changing it.");
    }
  }

  /** Copies a server file into {@code to}. Returns its size. */
  public synchronized long download(String path, OutputStream to, Progress progress) throws Exception {
    ChannelSftp ch = channel();
    SftpATTRS a = ch.stat(path);
    if (a.isDir()) throw new Exception("Folders cannot be downloaded on a phone yet; open it and copy its files");
    ch.get(path, to, monitor(progress));
    return a.getSize();
  }

  /** Copies {@code from} to a new file {@code name} in folder {@code folder}; never overwrites. */
  public synchronized String upload(InputStream from, String folder, String name, Progress progress) throws Exception {
    ChannelSftp ch = channel();
    String target = join(folder, name.replace('/', '_'));
    if (exists(target)) throw new Exception("\"" + name + "\" is already there. Rename or delete it first.");
    ch.put(from, target, monitor(progress), ChannelSftp.OVERWRITE);
    return target;
  }

  private boolean exists(String path) throws Exception {
    try {
      channel().lstat(path);
      return true;
    } catch (SftpException e) {
      if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) return false;
      throw e;
    }
  }

  private static SftpProgressMonitor monitor(Progress progress) {
    return new SftpProgressMonitor() {
      private long done;

      @Override
      public void init(int op, String src, String dest, long max) {}

      @Override
      public boolean count(long count) {
        done += count;
        return progress == null || progress.copied(done);
      }

      @Override
      public void end() {}
    };
  }

  static String join(String folder, String name) {
    return folder.endsWith("/") ? folder + name : folder + "/" + name;
  }

  static String parentOf(String path) {
    int slash = path.lastIndexOf('/');
    return slash <= 0 ? "/" : path.substring(0, slash);
  }

  static String nameOf(String path) {
    return path.substring(path.lastIndexOf('/') + 1);
  }
}
