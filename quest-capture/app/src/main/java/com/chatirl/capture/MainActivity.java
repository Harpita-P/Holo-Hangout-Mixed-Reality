package com.chatirl.capture;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.text.DateFormat;
import java.util.Date;

public final class MainActivity extends Activity {
    private static final int CAPTURE_REQUEST = 2501;
    private static final int NOTIFICATION_REQUEST = 2502;

    private EditText hostInput;
    private EditText portInput;
    private EditText urlInput;
    private TextView stateView;
    private TextView logView;
    private boolean receiverRegistered;

    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            renderStatus(
                    intent.getStringExtra(CaptureService.EXTRA_STATE),
                    intent.getStringExtra(CaptureService.EXTRA_DETAIL)
            );
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildUi());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[] {Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFICATION_REQUEST
            );
        }
    }

    private View buildUi() {
        int padding = dp(24);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(padding, padding, padding, padding);
        content.setBackgroundColor(Color.rgb(7, 24, 29));

        TextView title = text("HoloHangout Capture", 28, Color.WHITE);
        content.addView(title);
        content.addView(text(
                "MediaProjection → hardware H.264 → TCP → OBS",
                16,
                Color.rgb(180, 215, 212)
        ));

        stateView = text("STOPPED · Capture is stopped", 18, Color.rgb(46, 215, 196));
        stateView.setPadding(0, dp(18), 0, dp(12));
        content.addView(stateView);

        hostInput = input("Receiver host", "127.0.0.1");
        content.addView(hostInput);
        portInput = input("Receiver port", "49152");
        portInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        content.addView(portInput);
        urlInput = input("HoloHangout URL", "https://localhost:8081/");
        content.addView(urlInput);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(12), 0, dp(12));
        Button start = button("Start Capture");
        start.setOnClickListener((view) -> requestCapture());
        actions.addView(start);
        Button stop = button("Stop Capture");
        stop.setOnClickListener((view) -> stopCapture());
        actions.addView(stop);
        Button browser = button("Open HoloHangout");
        browser.setOnClickListener((view) -> openChatIRL());
        actions.addView(browser);
        content.addView(actions);

        content.addView(text("Diagnostics", 18, Color.WHITE));
        logView = text("Ready. Start the computer receiver before capture.\n", 14, Color.LTGRAY);
        logView.setTextIsSelectable(true);
        content.addView(logView);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        return scroll;
    }

    private void requestCapture() {
        MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        appendLog("Requesting Horizon OS screen-capture consent");
        startActivityForResult(manager.createScreenCaptureIntent(), CAPTURE_REQUEST);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != CAPTURE_REQUEST) return;
        if (resultCode != RESULT_OK || data == null) {
            renderStatus("stopped", "Capture permission was not granted");
            return;
        }

        int port;
        try {
            port = Integer.parseInt(portInput.getText().toString().trim());
        } catch (NumberFormatException error) {
            renderStatus("error", "Receiver port must be a number");
            return;
        }
        Intent service = new Intent(this, CaptureService.class)
                .setAction(CaptureService.ACTION_START)
                .putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(CaptureService.EXTRA_RESULT_DATA, data)
                .putExtra(CaptureService.EXTRA_HOST, hostInput.getText().toString().trim())
                .putExtra(CaptureService.EXTRA_PORT, port);
        startForegroundService(service);
        renderStatus("starting", "Starting 1280×720 at 30 FPS");
    }

    private void stopCapture() {
        startService(new Intent(this, CaptureService.class).setAction(CaptureService.ACTION_STOP));
    }

    private void openChatIRL() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(urlInput.getText().toString().trim())));
            appendLog("Opened HoloHangout in Quest Browser; capture service remains active");
        } catch (Exception error) {
            renderStatus("error", "Unable to open HoloHangout URL: " + error.getMessage());
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(CaptureService.ACTION_STATUS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(statusReceiver, filter);
        }
        receiverRegistered = true;
        renderStatus(CaptureService.getCurrentState(), CaptureService.getCurrentDetail());
    }

    @Override
    protected void onStop() {
        if (receiverRegistered) unregisterReceiver(statusReceiver);
        receiverRegistered = false;
        super.onStop();
    }

    private void renderStatus(String state, String detail) {
        String safeState = state == null ? "unknown" : state;
        String safeDetail = detail == null ? "No detail" : detail;
        stateView.setText(safeState.toUpperCase() + " · " + safeDetail);
        appendLog(safeState + ": " + safeDetail);
    }

    private void appendLog(String message) {
        if (logView == null) return;
        String time = DateFormat.getTimeInstance(DateFormat.MEDIUM).format(new Date());
        logView.append(time + "  " + message + "\n");
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        return view;
    }

    private EditText input(String hint, String value) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setText(value);
        input.setSingleLine(true);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.GRAY);
        return input;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        return button;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
