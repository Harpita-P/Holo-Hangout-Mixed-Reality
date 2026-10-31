# Quest Capture and OBS

## What is installed

- **HoloHangout World:** local WebXR experience at `https://localhost:8081/`.
- **HoloHangout Capture:** [ready-to-install Quest APK](../release/HoloHangout-Capture.apk) that captures the compositor after explicit Android consent.

The prebuilt APK is intended for local sideloading and uses package ID `com.chatirl.capture` to preserve compatibility with existing installations. Streamers do not need Android Studio or an Android build environment.

## Install the APK

```bash
adb devices
npm run capture:install:release
```

HoloHangout Capture appears under Quest's development/unknown sources. Reinstall only when the APK changes.

## One-time OBS configuration

1. Install OBS Studio 28 or newer.
2. In **Settings → Stream**, connect Twitch. OBS retains the stream destination; HoloHangout never stores the stream key.
3. Create a scene named `HoloHangout Live`.
4. Add a **Media Source** named `Quest Capture Feed`.
5. Disable **Local File** and set Input to:

   ```text
   udp://127.0.0.1:49153?fifo_size=1000000&overrun_nonfatal=1
   ```

6. Set Input Format to `mpegts`, reconnect delay to one second, and enable hardware decoding when available.
7. Fit the source to a 1280×720, 30 FPS canvas and add the streamer microphone separately.
8. In **Tools → obs-websocket Settings**, enable the server on port `4455`, retain authentication, and add its password to `.env`:

   ```dotenv
   OBS_ENABLED=true
   OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
   OBS_WEBSOCKET_PASSWORD=your_local_obs_password
   OBS_SCENE_NAME=HoloHangout Live
   OBS_NATIVE_CAPTURE_SOURCE_NAME=Quest Capture Feed
   OBS_FALLBACK_CAPTURE_SOURCE_NAME=MQDH Cast
   ```

MQDH window capture remains an optional fallback source named `MQDH Cast`.

## Every stream

1. Connect Quest through USB.
2. Run `npm run start:holohangout`.
3. Open OBS.
4. Open **HoloHangout Capture** in Quest.
5. Select **Start Capture → Entire View** and approve the system prompt.
6. Select **Open HoloHangout**.
7. In Quest Browser, accept the local certificate warning if shown and select **Enter AR**.
8. Confirm the dashboard reports encoded video and a healthy native OBS source.
9. Confirm visible movement in OBS, then select **Start Stream** in the dashboard.

Android requires fresh screen-capture consent each session. Audio from Quest is not captured; use the OBS microphone path.
