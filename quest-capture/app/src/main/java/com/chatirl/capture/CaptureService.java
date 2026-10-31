package com.chatirl.capture;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.view.Surface;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

public final class CaptureService extends Service {
    static final String ACTION_START = "com.chatirl.capture.START";
    static final String ACTION_STOP = "com.chatirl.capture.STOP";
    static final String ACTION_STATUS = "com.chatirl.capture.STATUS";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_RESULT_DATA = "resultData";
    static final String EXTRA_HOST = "host";
    static final String EXTRA_PORT = "port";
    static final String EXTRA_STATE = "state";
    static final String EXTRA_DETAIL = "detail";

    private static final String TAG = "ChatIRLCapture";
    private static final String CHANNEL_ID = "chatirl_capture";
    private static final int NOTIFICATION_ID = 2501;
    private static final int WIDTH = 1280;
    private static final int HEIGHT = 720;
    private static final int FRAME_RATE = 30;
    private static final int BIT_RATE = 5_000_000;

    private static volatile String currentState = "stopped";
    private static volatile String currentDetail = "Capture is stopped";

    private final AtomicBoolean capturing = new AtomicBoolean(false);
    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private MediaCodec encoder;
    private Surface encoderSurface;
    private Thread drainThread;
    private TcpVideoPublisher publisher;

    static String getCurrentState() {
        return currentState;
    }

    static String getCurrentDetail() {
        return currentDetail;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "HoloHangout capture",
                NotificationManager.IMPORTANCE_LOW
        );
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopCapture("Stopped by streamer");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) return START_NOT_STICKY;
        if (capturing.get()) {
            publishStatus("streaming", "Capture is already running");
            return START_NOT_STICKY;
        }

        startProjectionForeground("Starting compositor capture");
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED);
        Intent resultData = readResultData(intent);
        String host = intent.getStringExtra(EXTRA_HOST);
        int port = intent.getIntExtra(EXTRA_PORT, 49152);
        if (resultCode != Activity.RESULT_OK || resultData == null) {
            failAndStop("Missing or denied MediaProjection consent");
            return START_NOT_STICKY;
        }

        try {
            startCapture(resultCode, resultData, host == null ? "127.0.0.1" : host, port);
        } catch (Exception error) {
            Log.e(TAG, "Unable to start capture", error);
            failAndStop(error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        return START_NOT_STICKY;
    }

    private void startCapture(int resultCode, Intent resultData, String host, int port)
            throws IOException {
        stopping.set(false);
        MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        mediaProjection = manager.getMediaProjection(resultCode, resultData);
        if (mediaProjection == null) throw new IllegalStateException("MediaProjection was unavailable");
        mediaProjection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                mainHandler.post(() -> {
                    stopCapture("Projection ended by Horizon OS");
                    stopSelf();
                });
            }
        }, mainHandler);

        MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, WIDTH, HEIGHT);
        format.setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
        );
        format.setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE);
        format.setInteger(MediaFormat.KEY_FRAME_RATE, FRAME_RATE);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            format.setInteger(MediaFormat.KEY_PREPEND_HEADER_TO_SYNC_FRAMES, 1);
        }

        encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        encoderSurface = encoder.createInputSurface();
        encoder.start();

        publisher = new TcpVideoPublisher(host, port, new TcpVideoPublisher.Listener() {
            @Override
            public void onState(String state, String detail) {
                publishStatus(state, detail);
            }

            @Override
            public void onReceiverConnected() {
                requestKeyFrame();
            }
        });
        publishStatus("waiting", "Capture active; waiting for computer receiver at " + host + ":" + port);
        publisher.start();

        capturing.set(true);
        virtualDisplay = mediaProjection.createVirtualDisplay(
                "HoloHangout compositor capture",
                WIDTH,
                HEIGHT,
                320,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                encoderSurface,
                null,
                null
        );
        drainThread = new Thread(this::drainEncoder, "ChatIRL-H264-Drain");
        drainThread.start();
    }

    private void drainEncoder() {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (capturing.get()) {
            try {
                int index = encoder.dequeueOutputBuffer(info, 10_000);
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat format = encoder.getOutputFormat();
                    byte[] sps = readBuffer(format.getByteBuffer("csd-0"));
                    byte[] pps = readBuffer(format.getByteBuffer("csd-1"));
                    publisher.setCodecConfig(AnnexB.combine(sps, pps));
                    Log.i(TAG, "Encoder format ready: " + format);
                } else if (index >= 0) {
                    ByteBuffer output = encoder.getOutputBuffer(index);
                    if (output != null && info.size > 0) {
                        output.position(info.offset);
                        output.limit(info.offset + info.size);
                        byte[] encoded = new byte[info.size];
                        output.get(encoded);
                        byte[] annexB = AnnexB.normalize(encoded);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                            publisher.setCodecConfig(annexB);
                        } else {
                            publisher.offer(annexB);
                        }
                    }
                    encoder.releaseOutputBuffer(index, false);
                }
            } catch (IllegalStateException error) {
                if (capturing.get()) {
                    Log.e(TAG, "Encoder stopped unexpectedly", error);
                    mainHandler.post(() -> {
                        stopCapture("Encoder stopped unexpectedly");
                        stopSelf();
                    });
                }
                return;
            }
        }
    }

    private void requestKeyFrame() {
        MediaCodec activeEncoder = encoder;
        if (activeEncoder == null) return;
        try {
            Bundle parameters = new Bundle();
            parameters.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            activeEncoder.setParameters(parameters);
        } catch (IllegalStateException error) {
            Log.w(TAG, "Unable to request an immediate keyframe", error);
        }
    }

    private void stopCapture(String detail) {
        if (!stopping.compareAndSet(false, true)) return;
        capturing.set(false);
        if (publisher != null) publisher.close();
        publisher = null;
        if (virtualDisplay != null) virtualDisplay.release();
        virtualDisplay = null;
        if (drainThread != null) {
            drainThread.interrupt();
            try {
                drainThread.join(500);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        }
        drainThread = null;
        if (encoder != null) {
            try {
                encoder.stop();
            } catch (IllegalStateException ignored) {
                // The codec may already have been stopped by the system callback.
            }
            encoder.release();
        }
        encoder = null;
        if (encoderSurface != null) encoderSurface.release();
        encoderSurface = null;
        MediaProjection projection = mediaProjection;
        mediaProjection = null;
        if (projection != null) projection.stop();
        publishStatus("stopped", detail);
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private void failAndStop(String detail) {
        stopCapture(detail);
        publishStatus("error", detail);
        stopSelf();
    }

    private void publishStatus(String state, String detail) {
        currentState = state;
        currentDetail = detail;
        Log.i(TAG, state + ": " + detail);
        Intent status = new Intent(ACTION_STATUS)
                .setPackage(getPackageName())
                .putExtra(EXTRA_STATE, state)
                .putExtra(EXTRA_DETAIL, detail);
        sendBroadcast(status);
        if (!"stopped".equals(state) && !"error".equals(state)) {
            getSystemService(NotificationManager.class)
                    .notify(NOTIFICATION_ID, buildNotification(detail));
        }
    }

    private void startProjectionForeground(String detail) {
        Notification notification = buildNotification(detail);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification(String detail) {
        PendingIntent openApp = PendingIntent.getActivity(
                this,
                0,
                new Intent(this, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        PendingIntent stopCapture = PendingIntent.getService(
                this,
                1,
                new Intent(this, CaptureService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.presence_video_online)
                .setContentTitle("HoloHangout compositor capture")
                .setContentText(detail)
                .setOngoing(true)
                .setContentIntent(openApp)
                .addAction(new Notification.Action.Builder(null, "Stop", stopCapture).build())
                .build();
    }

    private static byte[] readBuffer(ByteBuffer buffer) {
        if (buffer == null) return new byte[0];
        ByteBuffer copy = buffer.duplicate();
        byte[] bytes = new byte[copy.remaining()];
        copy.get(bytes);
        return bytes;
    }

    @SuppressWarnings("deprecation")
    private static Intent readResultData(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class);
        }
        return intent.getParcelableExtra(EXTRA_RESULT_DATA);
    }

    @Override
    public void onDestroy() {
        stopCapture("Capture service destroyed");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
