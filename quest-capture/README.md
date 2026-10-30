# ChatIRL Quest compositor capture proof of concept

This companion is a deliberately small Android app for Quest 3/3S. It requests
the normal Horizon OS screen-capture consent, keeps that single-use projection
inside a `mediaProjection` foreground service, sends hardware-encoded H.264 over
TCP, and leaves ChatIRL running in Quest Browser.

It does not contain the ChatIRL scene, Twitch credentials, a Twitch stream key,
or audio capture. The existing MQDH workflow remains available as a fallback.

## Data path

```text
Horizon OS compositor (passthrough + hands + WebXR)
  -> MediaProjection surface
  -> Quest hardware H.264 encoder (1280x720, 30 FPS, 5 Mbps)
  -> TCP 127.0.0.1:49152 through adb reverse
  -> tools/quest-capture-receiver.mjs on the Mac
  -> FFmpeg stream-copy into MPEG-TS over UDP 127.0.0.1:49153
  -> OBS Media Source
```

The receiver does not re-encode video. FFmpeg only adds the MPEG-TS container
that OBS expects, so the Mac avoids both ScreenCaptureKit and software video
encoding for this input.

## Platform lifecycle implemented

- Capture begins only after explicit user approval of the system
  `MediaProjection` dialog.
- The permission result is used once and is never stored or reused.
- The service calls `startForeground` with the `mediaProjection` service type
  before obtaining the projection.
- A `MediaProjection.Callback` releases the encoder, surface, virtual display,
  socket, and notification if Horizon OS ends the session.
- A second projection is not started over an existing session.
- The service is not automatically restarted because a restarted service cannot
  reuse a consumed projection token.

Meta documents MediaProjection as the supported Quest API for casting,
livestreaming, and screen sharing:
https://developers.meta.com/vr/documentation/native/native-media-projection/

Android's current foreground-service and per-session consent requirements are
documented here:
https://developer.android.com/media/grow/media-projection

## Build and install

Requirements on the Mac:

- Java 11
- Android SDK Platform and Build Tools 33 or newer
- `adb`
- FFmpeg
- Node.js from the repository `.nvmrc`

Build from the repository root:

```sh
npm run capture:build
```

The debug APK is written to:

```text
quest-capture/app/build/outputs/apk/debug/app-debug.apk
```

Connect the Quest by USB, approve USB debugging, then install or update it:

```sh
adb devices
npm run capture:install
```

The app appears under the Quest library's unknown/development sources as
**ChatIRL Capture**. It can also be launched from the Mac:

```sh
adb shell monkey -p com.chatirl.capture \
  -c android.intent.category.LAUNCHER 1
```

## Prepare the USB transport and receiver

Keep the existing HTTPS reverse for ChatIRL and add the capture reverse:

```sh
adb reverse tcp:8081 tcp:8081
adb reverse tcp:49152 tcp:49152
adb reverse --list
```

Start the Mac receiver before selecting **Start Capture** in the headset:

```sh
npm run capture:receiver
```

Expected receiver startup output includes:

```text
Listening for Quest H.264 on tcp://127.0.0.1:49152.
OBS Media Source: udp://127.0.0.1:49153?fifo_size=1000000&overrun_nonfatal=1
```

The companion's default receiver host is `127.0.0.1`. Through `adb reverse`,
that address reaches the Mac without Wi-Fi or a LAN firewall exception.

## Configure OBS without screen capture

Keep the existing MQDH scene for fallback. Create a separate test scene, then:

1. Add **Media Source** and name it `Quest Capture Feed`.
2. Uncheck **Local File**.
3. Set **Input** to:

   ```text
   udp://127.0.0.1:49153?fifo_size=1000000&overrun_nonfatal=1
   ```

4. Set **Input Format** to `mpegts`.
5. Enable hardware decoding when available.
6. Set the reconnect delay to one second.
7. Fit the source to the 1280x720 canvas.

Do not add macOS Screen Capture, Window Capture, or Display Capture to this test
scene. OBS should receive only the local UDP media feed plus the normal streamer
microphone.

After the native feed is verified, `OBS_CAPTURE_SOURCE_NAME` may be changed to
`Quest Capture Feed` so the existing ChatIRL dashboard preflight recognizes it.
Until then, leave the MQDH source configuration unchanged.

## Run on Quest

1. Stop MQDH casting. Horizon OS permits only one active MediaProjection session.
2. Start the ChatIRL server and IWSDK app normally.
3. Start `npm run capture:receiver` on the Mac.
4. Open **ChatIRL Capture** on Quest.
5. Leave receiver host `127.0.0.1` and port `49152` unchanged.
6. Select **Start Capture** and approve the Horizon OS capture dialog.
7. Wait for the app status to change from **WAITING** to **STREAMING**.
8. Select **Open ChatIRL**. The capture foreground service remains active while
   Quest Browser becomes the foreground application.
9. Enter AR in ChatIRL and check the `Quest Capture Feed` source in OBS.
10. Return to the companion or use its persistent notification to stop capture.

Starting a new capture always requires another explicit consent. The app does
not attempt to bypass or remember that permission.

## Diagnostics

The native app reports `starting`, `waiting`, `streaming`, `stopped`, or `error`
and keeps a short visible event log. The Mac receiver reports connection time
and measured incoming bitrate every five seconds.

For complete device logs:

```sh
adb logcat -c
adb logcat -s ChatIRLCapture
```

Common states:

- **WAITING**: the capture and encoder are active, but the Mac receiver is not
  reachable. Confirm the receiver process and `adb reverse --list`.
- **STREAMING**: the Quest TCP connection is active. The receiver should report
  roughly the configured 5 Mbps during motion.
- OBS remains black: verify the source format is `mpegts`, keep the source
  visible, and restart capture to force fresh SPS/PPS plus an immediate keyframe.
- **Projection ended by Horizon OS**: another casting session started, the user
  stopped sharing, the screen locked, or Horizon OS killed the projection.

## Real-device acceptance test

The Mac transport has an automated synthetic-stream check during development,
but the following items require the physical Quest compositor:

1. Open `https://localhost:8081/capture-test.html` for two minutes. The timestamp
   and orange marker must move continuously in OBS.
2. Open ChatIRL and enter immersive AR.
3. Confirm real-room passthrough, tabletop, avatars, and hand visualization all
   appear in OBS.
4. Exercise `!join`, `!wave`, `!dance`, `!jump`, `!run`, and `!leave`.
5. Grab and release the cube, table, and a viewer avatar.
6. Continue for at least ten minutes while watching the receiver's bitrate and
   the OBS program view.
7. Confirm there is no frame frozen for more than five seconds while the headset
   view is visibly moving.
8. Check that Quest interaction remains comfortable and that latency is
   acceptable for chat responses.

Still unverified until that test: compositor passthrough inclusion, hand-layer
inclusion, Horizon OS foreground-service survival during immersive Quest Browser,
Quest hardware-encoder behavior, thermal impact, crop/letterboxing, and measured
end-to-end latency. Audio is intentionally out of scope.
