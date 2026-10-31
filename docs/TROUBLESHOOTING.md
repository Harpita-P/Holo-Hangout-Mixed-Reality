# Troubleshooting

Start with `npm run check`.

If macOS blocks the double-clickable launcher because it came from the internet, Control-click `Start HoloHangout.command`, choose **Open**, and confirm once. The launcher runs the same repository command documented in the README.

On Windows, run `Start HoloHangout.cmd` or use `npm run start:holohangout` from PowerShell. If `adb` or `ffmpeg` is not found, add its installation folder to the Windows `PATH`, open a new PowerShell window, and run `npm run check` again.

## Quest is not detected

Use a USB data cable, enable developer mode, approve USB debugging inside Quest, and run `adb devices`. The state must be `device`, not `unauthorized`.

## Quest Browser says connection refused

Keep `npm run start:holohangout` running and reconfigure forwarding:

```bash
adb reverse tcp:8081 tcp:8081
adb reverse tcp:49152 tcp:49152
```

Quest's `localhost` reaches the local computer only through these mappings.

## Certificate warning

IWSDK uses local HTTPS because immersive WebXR requires a secure context. Accept the local certificate warning for `https://localhost:8081/`; do not replace it with HTTP.

## Twitch will not connect

Confirm `.env` credentials and the exact redirect `http://localhost:8787/auth/twitch/callback`. Restart after changing `.env`, and reconnect Twitch after changing scopes, a password, or an application secret.

## Capture says WAITING

Confirm the dashboard receiver is listening and `adb reverse --list` includes port `49152`. Stop MQDH casting before native capture; only one MediaProjection session can be active.

## OBS is black or unavailable

Open OBS, enable its WebSocket server, verify `.env` names/password, set Media Source format to `mpegts`, keep the source visible, and restart Capture to force fresh H.264 headers.

## A port is already in use

Stop an older HoloHangout Terminal window. Ports `8787`, `8081`, `49152`, and `49153` belong to the toolkit; OBS WebSocket normally uses `4455`.
