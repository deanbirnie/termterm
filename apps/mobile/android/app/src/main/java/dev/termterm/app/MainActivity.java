package dev.termterm.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Plugins that live in this app (rather than in an npm package) are registered by hand.
    registerPlugin(SshPlugin.class);
    registerPlugin(DeviceKeyPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
