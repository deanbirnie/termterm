package dev.termterm.app.ssh;

import com.jcraft.jsch.ChannelDirectTCPIP;
import com.jcraft.jsch.Session;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.BindException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * One port forward through a saved host, like ssh -L, -R and -D.
 *
 * <ul>
 *   <li>local: a port on this phone reaches destHost:destPort through the server;
 *   <li>remote: a port on the server reaches destHost:destPort from this phone;
 *   <li>dynamic: a SOCKS5 proxy on this phone whose connections go out through the server.
 * </ul>
 *
 * <p>Local and dynamic forwards listen here and open a direct-tcpip channel
 * per connection, so they can report how many are open. Remote forwards are
 * the server's to accept (JSch's port forwarding), so no count is known.
 *
 * <p>No Android dependencies: compiled and tested on a plain JVM.
 */
public final class ForwardSession {

  public interface Events {
    /** Listening (or, for remote, accepted by the server). */
    void active();

    /** How many connections are open now (local and dynamic only). */
    void connections(int open);

    /** Called once. {@code error} is null when stopped on purpose. */
    void closed(String error);
  }

  public static final class Spec {
    /** "local", "remote" or "dynamic". */
    public String kind;
    public String bindHost;
    public int bindPort;
    public String destHost;
    public int destPort;
  }

  private final SshSession.Config config;
  private final Spec spec;
  private final Events events;
  private final SshConnector connector;
  private final AtomicInteger open = new AtomicInteger();
  private final Set<Socket> sockets = ConcurrentHashMap.newKeySet();
  private volatile ServerSocket listener;
  private volatile boolean stopping;
  private volatile boolean closedReported;

  public ForwardSession(SshSession.Config config, Spec spec, Events events, SshSession.Prompter prompter) {
    this.config = config;
    this.spec = spec;
    this.events = events;
    this.connector = new SshConnector(prompter);
  }

  /** Connects and starts forwarding on a new thread; returns at once. */
  public void start() {
    Thread thread = new Thread(this::run, "forward-" + spec.bindPort);
    thread.setDaemon(true);
    thread.start();
  }

  public void stop() {
    stopping = true;
    shutDown();
  }

  private void run() {
    String error = null;
    try {
      Session s = connector.open(config);
      if (s == null) return;
      if ("remote".equals(spec.kind)) {
        try {
          s.setPortForwardingR(spec.bindHost, spec.bindPort, spec.destHost, spec.destPort);
        } catch (Exception e) {
          throw new IOException("The server refused to listen on port " + spec.bindPort + " (" + connector.describe(e) + ")");
        }
        events.active();
        while (!stopping && s.isConnected()) Thread.sleep(500);
      } else {
        ServerSocket server = new ServerSocket();
        server.setReuseAddress(true);
        try {
          server.bind(new InetSocketAddress(InetAddress.getByName(spec.bindHost), spec.bindPort));
        } catch (BindException e) {
          server.close();
          throw new IOException("Port " + spec.bindPort + " is already in use on this device");
        }
        listener = server;
        if (stopping) return;
        events.active();
        while (!stopping) {
          Socket client;
          try {
            client = server.accept();
          } catch (IOException e) {
            break; // closed by stop(), or the connection was lost
          }
          if (!s.isConnected()) {
            client.close();
            break;
          }
          handle(s, client);
        }
      }
      if (!stopping) error = SshSession.LOST;
    } catch (Exception e) {
      if (!stopping) error = e instanceof IOException && e.getMessage() != null ? e.getMessage() : connector.describe(e);
    } finally {
      shutDown();
      if (!closedReported) {
        closedReported = true;
        events.closed(stopping ? null : error);
      }
    }
  }

  /** One connection to the local port: through to the destination, on its own thread. */
  private void handle(Session s, Socket client) {
    sockets.add(client);
    events.connections(open.incrementAndGet());
    Thread t =
        new Thread(
            () -> {
              ChannelDirectTCPIP ch = null;
              try {
                InputStream in = client.getInputStream();
                OutputStream out = client.getOutputStream();
                String host = spec.destHost;
                int port = spec.destPort;
                if ("dynamic".equals(spec.kind)) {
                  Target target = socksHandshake(in, out);
                  if (target == null) return;
                  host = target.host;
                  port = target.port;
                }
                ch = (ChannelDirectTCPIP) s.openChannel("direct-tcpip");
                ch.setHost(host);
                ch.setPort(port);
                InputStream fromRemote = ch.getInputStream();
                OutputStream toRemote = ch.getOutputStream();
                try {
                  ch.connect(SshConnector.CONNECT_TIMEOUT_MS);
                } catch (Exception e) {
                  if ("dynamic".equals(spec.kind)) socksReply(out, 5); // connection refused
                  return;
                }
                if ("dynamic".equals(spec.kind)) socksReply(out, 0);
                Thread upload = pump(in, toRemote, ch);
                pump(fromRemote, out, null).join();
                upload.interrupt();
              } catch (Exception e) {
                // The connection ends; the forward carries on.
              } finally {
                if (ch != null) ch.disconnect();
                close(client);
                sockets.remove(client);
                events.connections(open.decrementAndGet());
              }
            },
            "forward-conn");
    t.setDaemon(true);
    t.start();
  }

  /** Copies until the source ends; then closes the far side for writing. */
  private static Thread pump(InputStream from, OutputStream to, ChannelDirectTCPIP channel) {
    Thread t =
        new Thread(
            () -> {
              byte[] buffer = new byte[32 * 1024];
              try {
                int n;
                while ((n = from.read(buffer)) != -1) {
                  to.write(buffer, 0, n);
                  to.flush();
                }
              } catch (IOException e) {
                // either side closed
              } finally {
                try {
                  if (channel != null) channel.getOutputStream().close();
                  else to.close();
                } catch (IOException ignored) {
                  // already closed
                }
              }
            },
            "forward-pump");
    t.setDaemon(true);
    t.start();
    return t;
  }

  private static final class Target {
    String host;
    int port;
  }

  /**
   * SOCKS5 (RFC 1928), "no authentication", CONNECT only. The proxy listens on
   * this device (127.0.0.1 unless chosen otherwise), so it is only reachable
   * from here. Returns null after refusing anything else.
   */
  static Target socksHandshake(InputStream rawIn, OutputStream out) throws IOException {
    DataInputStream in = new DataInputStream(rawIn);
    if (in.readUnsignedByte() != 5) return null;
    int methods = in.readUnsignedByte();
    boolean noAuth = false;
    for (int i = 0; i < methods; i++) if (in.readUnsignedByte() == 0) noAuth = true;
    out.write(new byte[] {5, (byte) (noAuth ? 0 : 0xff)});
    out.flush();
    if (!noAuth) return null;
    if (in.readUnsignedByte() != 5) return null;
    int command = in.readUnsignedByte();
    in.readUnsignedByte(); // reserved
    int type = in.readUnsignedByte();
    Target t = new Target();
    if (type == 1) {
      byte[] a = new byte[4];
      in.readFully(a);
      t.host = InetAddress.getByAddress(a).getHostAddress();
    } else if (type == 3) {
      byte[] name = new byte[in.readUnsignedByte()];
      in.readFully(name);
      t.host = new String(name, StandardCharsets.US_ASCII);
    } else if (type == 4) {
      byte[] a = new byte[16];
      in.readFully(a);
      t.host = InetAddress.getByAddress(a).getHostAddress();
    } else {
      socksReply(out, 8); // address type not supported
      return null;
    }
    t.port = in.readUnsignedShort();
    if (command != 1) {
      socksReply(out, 7); // only CONNECT
      return null;
    }
    return t;
  }

  static void socksReply(OutputStream out, int code) throws IOException {
    out.write(new byte[] {5, (byte) code, 0, 1, 0, 0, 0, 0, 0, 0});
    out.flush();
  }

  private void shutDown() {
    ServerSocket server = listener;
    listener = null;
    if (server != null) {
      try {
        server.close();
      } catch (IOException ignored) {
        // already closed
      }
    }
    for (Socket socket : sockets) close(socket);
    connector.close();
  }

  private static void close(Socket socket) {
    try {
      socket.close();
    } catch (IOException ignored) {
      // already closed
    }
  }
}
