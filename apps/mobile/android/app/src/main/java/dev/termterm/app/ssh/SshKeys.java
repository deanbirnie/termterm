package dev.termterm.app.ssh;

import com.jcraft.jsch.JSch;
import com.jcraft.jsch.KeyPair;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** Creating and reading SSH keys. No Android dependencies. */
public final class SshKeys {
  private SshKeys() {}

  public static final class Result {
    /** OpenSSH private key text. */
    public String privateKey;
    /** The public key blob (what follows the type in an authorized_keys line). */
    public byte[] publicKeyBlob;
    /** For example "ssh-ed25519" or "ssh-rsa". */
    public String keyType;
  }

  /** A problem the user can act on; the message is shown as is. */
  public static final class KeyException extends Exception {
    public KeyException(String message) {
      super(message);
    }
  }

  public static Result generate(String type) throws KeyException {
    try {
      JSch jsch = new JSch();
      KeyPair pair =
          "rsa".equals(type)
              ? KeyPair.genKeyPair(jsch, KeyPair.RSA, 4096)
              : KeyPair.genKeyPair(jsch, KeyPair.ED25519);
      try {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        pair.writeOpenSSHv1PrivateKey(out, null);
        Result result = new Result();
        result.privateKey = new String(out.toByteArray(), StandardCharsets.UTF_8);
        result.publicKeyBlob = pair.getPublicKeyBlob();
        result.keyType = typeOf(result.publicKeyBlob);
        return result;
      } finally {
        pair.dispose();
      }
    } catch (Exception e) {
      throw new KeyException("Could not generate a key: " + e.getMessage());
    }
  }

  /** Validates a private key (and its passphrase) and derives the public half. */
  public static Result inspect(String privateKey, String passphrase) throws KeyException {
    String text = privateKey.trim() + "\n";
    KeyPair pair;
    try {
      pair = KeyPair.load(new JSch(), text.getBytes(StandardCharsets.UTF_8), null);
    } catch (Exception e) {
      throw new KeyException("Not a valid private key: " + e.getMessage());
    }
    try {
      if (pair.isEncrypted()) {
        if (passphrase == null || passphrase.isEmpty()) {
          throw new KeyException("This key is encrypted. Enter its passphrase.");
        }
        if (!pair.decrypt(passphrase.getBytes(StandardCharsets.UTF_8))) {
          throw new KeyException("Wrong passphrase for this key");
        }
      }
      byte[] blob = pair.getPublicKeyBlob();
      if (blob == null) throw new KeyException("Not a valid private key");
      Result result = new Result();
      result.privateKey = text;
      result.publicKeyBlob = blob;
      result.keyType = typeOf(blob);
      return result;
    } finally {
      pair.dispose();
    }
  }

  /** Reads the algorithm name from the start of a public key blob. */
  static String typeOf(byte[] blob) {
    if (blob.length < 4) return "unknown";
    int length =
        ((blob[0] & 0xff) << 24) | ((blob[1] & 0xff) << 16) | ((blob[2] & 0xff) << 8) | (blob[3] & 0xff);
    if (length <= 0 || length > blob.length - 4) return "unknown";
    return new String(blob, 4, length, StandardCharsets.US_ASCII);
  }
}
