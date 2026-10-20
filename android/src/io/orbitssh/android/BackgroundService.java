package io.orbitssh.android;

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

/**
 * Keeps the app process alive while SSH sessions run in the background.
 * Android only lets a backgrounded app keep working when a foreground
 * service shows a persistent notification.
 */
public final class BackgroundService extends Service {
    private static final String CHANNEL_ID = "OrbitSSH.Sessions";
    private static final int NOTIFICATION_ID = 1;
    private static final String ACTION_UPDATE = "io.orbitssh.android.action.UPDATE";
    private static final String EXTRA_TEXT = "text";

    private String text = "会话正在后台运行";

    /** Starts or stops the foreground service. */
    static void setActive(Context context, boolean active, String message) {
        Intent intent = new Intent(context, BackgroundService.class);
        if (!active) {
            context.stopService(intent);
            return;
        }
        intent.setAction(ACTION_UPDATE);
        intent.putExtra(EXTRA_TEXT, message);
        try {
            context.startForegroundService(intent);
        } catch (Exception ignored) {
            // The system can refuse to start a foreground service from the
            // background. The engine keeps running while the app is visible.
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String message = intent.getStringExtra(EXTRA_TEXT);
            if (message != null && !message.isEmpty()) text = message;
        }
        startForegroundCompat();
        // The engine owns the sessions, so the service restarts with the
        // process and the notification is rebuilt from the last text.
        return START_STICKY;
    }

    @Override public void onBind(Intent intent) {
        return null;
    }

    @Override public void onDestroy() {
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
            // Older releases do not know the removal flag.
            try { stopForeground(true); } catch (Exception ignoredAgain) { }
        }
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "后台会话", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("在后台保持 SSH 会话与文件传输");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private void startForegroundCompat() {
        Notification notification = build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification build() {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setSmallIcon(iconId())
            .setContentTitle("Orbit SSH")
            .setContentText(text)
            .setOngoing(true)
            .setShowWhen(false);
        PendingIntent content = launchIntent();
        if (content != null) builder.setContentIntent(content);
        return builder.build();
    }

    private int iconId() {
        // The resources are compiled without a generated R class, so the
        // notification icon is resolved by name.
        return getResources().getIdentifier("orbit", "drawable", getPackageName());
    }

    private PendingIntent launchIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, launch, flags);
    }
}
