package dev.termterm.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the app alive while SSH sessions are open.
 *
 * <p>Android stops an app's work soon after it leaves the screen unless the
 * app runs a foreground service, which must show a notification. This service
 * does nothing itself: the connections live in {@link SshPlugin}. It exists
 * so they are not cut off when the user switches apps or the screen turns off.
 */
public class SessionService extends Service {

  private static final String CHANNEL = "sessions";
  private static final int NOTIFICATION_ID = 1;
  private static final String EXTRA_COUNT = "count";

  /** Shows (or updates) the notification for {@code count} open sessions; 0 stops the service. */
  static void update(Context context, int count) {
    Intent intent = new Intent(context, SessionService.class);
    if (count <= 0) {
      context.stopService(intent);
      return;
    }
    intent.putExtra(EXTRA_COUNT, count);
    try {
      ContextCompat.startForegroundService(context, intent);
    } catch (RuntimeException e) {
      // Android refuses to start it when the app is not in the foreground.
      // Sessions still work while the app is open; they just are not protected.
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    int count = intent == null ? 1 : intent.getIntExtra(EXTRA_COUNT, 1);
    Notification notification = build(count);
    int type =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            : 0;
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
    } catch (RuntimeException e) {
      stopSelf();
    }
    // If Android kills the process the sessions are gone too, so do not restart.
    return START_NOT_STICKY;
  }

  private Notification build(int count) {
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
      NotificationChannel channel =
          new NotificationChannel(CHANNEL, "Open sessions", NotificationManager.IMPORTANCE_LOW);
      channel.setDescription("Shown while SSH sessions are open, so they stay connected.");
      channel.setShowBadge(false);
      manager.createNotificationChannel(channel);
    }
    Intent open = new Intent(this, MainActivity.class);
    open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent tap =
        PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return new NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat_session)
        .setContentTitle(count == 1 ? "1 SSH session open" : count + " SSH sessions open")
        .setContentText("Tap to return to termterm")
        .setContentIntent(tap)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_SERVICE)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
