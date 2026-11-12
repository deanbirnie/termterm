package dev.termterm.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Stores the vault key so that only a fingerprint or face can release it.
 *
 * <p>The vault key is encrypted with an AES key that lives in the Android
 * Keystore (hardware-backed where the device supports it) and is configured
 * to work only straight after a successful biometric check. The encrypted
 * copy sits in the app's private preferences; on its own it is useless.
 * Enrolling a new fingerprint permanently invalidates the Keystore key, so a
 * fingerprint added later by someone else cannot open the vault.
 */
@CapacitorPlugin(name = "DeviceKey")
public class DeviceKeyPlugin extends Plugin {

  private static final String KEYSTORE = "AndroidKeyStore";
  private static final String ALIAS = "termterm-vault-key";
  private static final String PREFS = "device-key";
  private static final String PREF_IV = "iv";
  private static final String PREF_DATA = "data";
  private static final String TRANSFORMATION = "AES/GCM/NoPadding";

  private SharedPreferences prefs() {
    return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  @PluginMethod
  public void available(PluginCall call) {
    int status =
        BiometricManager.from(getContext())
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
    JSObject out = new JSObject();
    out.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
    call.resolve(out);
  }

  @PluginMethod
  public void has(PluginCall call) {
    JSObject out = new JSObject();
    out.put("stored", prefs().contains(PREF_DATA));
    call.resolve(out);
  }

  @PluginMethod
  public void clear(PluginCall call) {
    forget();
    call.resolve();
  }

  /** Encrypts and stores the key. Asks for a fingerprint or face first. */
  @PluginMethod
  public void save(final PluginCall call) {
    final String key = call.getString("key");
    if (key == null) {
      call.reject("key is required");
      return;
    }
    final Cipher cipher;
    try {
      forget(); // a fresh Keystore key each time, tied to the fingerprints enrolled now
      KeyGenerator generator =
          KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
      generator.init(
          new KeyGenParameterSpec.Builder(
                  ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .setKeySize(256)
              .setUserAuthenticationRequired(true)
              .setInvalidatedByBiometricEnrollment(true)
              .build());
      SecretKey secret = generator.generateKey();
      cipher = Cipher.getInstance(TRANSFORMATION);
      cipher.init(Cipher.ENCRYPT_MODE, secret);
    } catch (Exception e) {
      call.reject("Could not set up fingerprint unlock on this device");
      return;
    }
    authenticate(
        call,
        cipher,
        "Turn on fingerprint unlock",
        "Confirm it is you to finish setting up",
        new Unlocked() {
          @Override
          public void with(Cipher ready) throws Exception {
            byte[] encrypted = ready.doFinal(Base64.decode(key, Base64.NO_WRAP));
            prefs()
                .edit()
                .putString(PREF_IV, Base64.encodeToString(ready.getIV(), Base64.NO_WRAP))
                .putString(PREF_DATA, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .apply();
            call.resolve();
          }
        });
  }

  /** Asks for a fingerprint or face, then returns the stored key. */
  @PluginMethod
  public void load(final PluginCall call) {
    String iv = prefs().getString(PREF_IV, null);
    final String data = prefs().getString(PREF_DATA, null);
    if (iv == null || data == null) {
      call.reject("Fingerprint unlock is not set up", "NOT_SET_UP");
      return;
    }
    final Cipher cipher;
    try {
      KeyStore store = KeyStore.getInstance(KEYSTORE);
      store.load(null);
      SecretKey secret = (SecretKey) store.getKey(ALIAS, null);
      if (secret == null) throw new KeyPermanentlyInvalidatedException();
      cipher = Cipher.getInstance(TRANSFORMATION);
      cipher.init(
          Cipher.DECRYPT_MODE, secret, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
    } catch (KeyPermanentlyInvalidatedException e) {
      forget();
      call.reject(
          "Your fingerprints or face have changed since this was set up. Unlock with your master"
              + " password; fingerprint unlock will be set up again.",
          "INVALIDATED");
      return;
    } catch (Exception e) {
      call.reject("Fingerprint unlock is not working. Use your master password.", "FAILED");
      return;
    }
    authenticate(
        call,
        cipher,
        "Unlock termterm",
        "Use your fingerprint or face",
        new Unlocked() {
          @Override
          public void with(Cipher ready) throws Exception {
            byte[] key = ready.doFinal(Base64.decode(data, Base64.NO_WRAP));
            JSObject out = new JSObject();
            out.put("key", Base64.encodeToString(key, Base64.NO_WRAP));
            call.resolve(out);
          }
        });
  }

  private interface Unlocked {
    void with(Cipher cipher) throws Exception;
  }

  private void authenticate(
      final PluginCall call,
      final Cipher cipher,
      final String title,
      final String subtitle,
      final Unlocked then) {
    final FragmentActivity activity = getActivity();
    activity.runOnUiThread(
        new Runnable() {
          @Override
          public void run() {
            BiometricPrompt prompt =
                new BiometricPrompt(
                    activity,
                    ContextCompat.getMainExecutor(activity),
                    new BiometricPrompt.AuthenticationCallback() {
                      @Override
                      public void onAuthenticationSucceeded(
                          @NonNull BiometricPrompt.AuthenticationResult result) {
                        try {
                          BiometricPrompt.CryptoObject crypto = result.getCryptoObject();
                          if (crypto == null || crypto.getCipher() == null) {
                            throw new IllegalStateException("no cipher");
                          }
                          then.with(crypto.getCipher());
                        } catch (Exception e) {
                          call.reject(
                              "Fingerprint unlock is not working. Use your master password.",
                              "FAILED");
                        }
                      }

                      @Override
                      public void onAuthenticationError(int code, @NonNull CharSequence message) {
                        boolean cancelled =
                            code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                                || code == BiometricPrompt.ERROR_USER_CANCELED
                                || code == BiometricPrompt.ERROR_CANCELED;
                        call.reject(
                            cancelled ? "Cancelled" : message.toString(),
                            cancelled ? "CANCELLED" : "FAILED");
                      }
                      // onAuthenticationFailed (a finger that did not match) is not
                      // final: the system prompt stays open for another try.
                    });
            BiometricPrompt.PromptInfo info =
                new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setNegativeButtonText("Use master password")
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                    .build();
            try {
              prompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
            } catch (Exception e) {
              call.reject("Fingerprint unlock is not available right now", "FAILED");
            }
          }
        });
  }

  private void forget() {
    prefs().edit().clear().apply();
    try {
      KeyStore store = KeyStore.getInstance(KEYSTORE);
      store.load(null);
      store.deleteEntry(ALIAS);
    } catch (Exception e) {
      // Nothing stored, or the Keystore is unavailable: either way nothing usable remains.
    }
  }
}
