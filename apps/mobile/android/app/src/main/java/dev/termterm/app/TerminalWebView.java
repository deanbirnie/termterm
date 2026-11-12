package dev.termterm.app;

import android.content.Context;
import android.os.Build;
import android.text.InputType;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import com.getcapacitor.CapacitorWebView;

/**
 * The app's WebView, with one addition: while the terminal has focus it tells
 * the on-screen keyboard not to autocorrect, suggest or learn from what is
 * typed.
 *
 * <p>A keyboard decides how to behave from the kind of field it is typing
 * into. A web page cannot say "this is a terminal", and keyboards ignore the
 * web's autocorrect hints, so "ls" becomes "is". Reporting the field as a
 * visible-password field with no suggestions is the signal keyboards do
 * honour: characters are passed through exactly as typed. Everywhere else in
 * the app the keyboard behaves normally.
 */
public class TerminalWebView extends CapacitorWebView {

  private volatile boolean terminalInput;

  public TerminalWebView(Context context, AttributeSet attrs) {
    super(context, attrs);
  }

  /** Called when the terminal gains or loses focus. */
  public void setTerminalInput(final boolean active) {
    if (terminalInput == active) return;
    terminalInput = active;
    post(
        new Runnable() {
          @Override
          public void run() {
            // Make the keyboard ask again what kind of field this is.
            InputMethodManager keyboard =
                (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            if (keyboard != null) keyboard.restartInput(TerminalWebView.this);
          }
        });
  }

  @Override
  public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
    InputConnection connection = super.onCreateInputConnection(outAttrs);
    if (terminalInput && connection != null) {
      outAttrs.inputType =
          InputType.TYPE_CLASS_TEXT
              | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
              | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
      outAttrs.imeOptions |= EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_FULLSCREEN;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        outAttrs.imeOptions |= EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING;
      }
    }
    return connection;
  }
}
