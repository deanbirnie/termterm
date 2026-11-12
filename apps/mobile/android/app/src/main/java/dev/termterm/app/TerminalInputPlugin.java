package dev.termterm.app;

import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Lets the interface say when the terminal has focus. See {@link TerminalWebView}. */
@CapacitorPlugin(name = "TerminalInput")
public class TerminalInputPlugin extends Plugin {

  @PluginMethod
  public void setActive(PluginCall call) {
    WebView webView = getBridge().getWebView();
    if (webView instanceof TerminalWebView) {
      ((TerminalWebView) webView).setTerminalInput(call.getBoolean("active", false));
    }
    call.resolve();
  }
}
