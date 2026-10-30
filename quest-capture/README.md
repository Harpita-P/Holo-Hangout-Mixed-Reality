# ChatIRL Phase 2.5 native Quest capture

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
  -> supervised receiver in the ChatIRL Node control server
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

## Configure the control server

Add these settings to the repository's `.env`:

```dotenv
QUEST_CAPTURE_ENABLED=true
QUEST_CAPTURE_AUTOSTART=true
QUEST_CAPTURE_ADB_AUTOCONFIGURE=false
QUEST_CAPTURE_PORT=49152
QUEST_CAPTURE_OBS_UDP_PORT=49153
QUEST_CAPTURE_STALL_THRESHOLD_MS=3000

OBS_NATIVE_CAPTURE_SOURCE_NAME=Quest Capture Feed
OBS_FALLBACK_CAPTURE_SOURCE_NAME=MQDH Cast
```

`npm run server` now starts and monitors the receiver. Open
`http://localhost:8787` and select **Configure USB** once the Quest is connected;
the button safely runs both required `adb reverse` mappings. Set
`QUEST_CAPTURE_ADB_AUTOCONFIGURE=true` if the Quest is normally attached before
the server starts and you want that step performed automatically.

The standalone receiver remains available for diagnostics, but do not run it at
the same time as the control server because both use TCP port 49152:

```sh
npm run capture:receiver
```

The companion's default receiver host is `127.0.0.1`. Through `adb reverse`,
that address reaches the Mac without Wi-Fi or a LAN firewall exception.

## Configure OBS without screen capture

Keep the existing `ChatIRL Live` scene and `MQDH Cast` source for fallback. In
the same scene:

1. Add **Media Source** and name it `Quest Capture Feed`.
2. Uncheck **Local File**.
3. Set **Input** to:

   ```text
   udp://127.0.0.1:49153?fifo_size=1000000&overrun_nonfatal=1
   ```

4. Set **Input Format** to `mpegts`.
5. Enable hardware decoding when available.
6. Set the reconnect delay to one second.
7. Fit the source to the 1280×720 canvas.
8. Keep `Quest Capture Feed` enabled for normal operation. The dashboard will
   prefer it only when receiver bytes are advancing and OBS reports playback.
9. Keep `MQDH Cast` in the scene as fallback. If both are enabled, starting a
   stream disables whichever source was not selected so it cannot cover the
   healthy feed.

The dashboard's **Use Native Feed** and **Use MQDH Fallback** buttons switch the
two scene items without requiring OBS source-panel edits. Native selection is
blocked unless receiver video is active. MQDH selection is explicit because OBS
cannot determine whether a window-capture source contains changing pixels; check
the Program view before going live.

The native source does not need macOS Screen Recording permission. OBS should
receive the local UDP media feed plus the normal streamer microphone. MQDH's
macOS capture source is used only when deliberately falling back.

## Run on Quest

1. Stop MQDH casting. Horizon OS permits only one active MediaProjection session.
2. Start the ChatIRL server and IWSDK app normally. The receiver starts with the
   control server.
3. Open `http://localhost:8787` and select **Configure USB**. Confirm **Mac
   receiver** is listening.
4. Open **ChatIRL Capture** on Quest.
5. Leave receiver host `127.0.0.1` and port `49152` unchanged.
6. Select **Start Capture → Entire View** and approve the Horizon OS dialog.
7. Wait for the app status to change from **WAITING** to **STREAMING**. The
   dashboard must show **Quest connection** and **Encoded video** healthy.
8. Select **Open ChatIRL**. The capture foreground service remains active while
   Quest Browser becomes the foreground application.
9. Enter AR in ChatIRL. Confirm `Quest Capture Feed` is moving in OBS and the
   dashboard's Broadcast card says **Native**.
10. Select **Start Stream** on the dashboard. This retains the existing
    `ChatIRL Live` scene, optional microphone delay, OBS WebSocket control, and
    OBS-owned Twitch account/stream key.
11. Select **Stop Stream** when finished, then return to the companion or use its
    persistent notification to stop capture.

Starting a new capture always requires another explicit consent. The app does
not attempt to bypass or remember that permission.

## Diagnostics

The native app reports `starting`, `waiting`, `streaming`, `stopped`, or `error`
and keeps a short visible event log. The dashboard reports receiver listening,
Quest TCP connectivity, reconnect count, measured bitrate, last video activity,
OBS Media Source playback state, and a stall after three seconds without new
H.264 bytes.

This detects a stopped encoder, broken TCP path, receiver restart, or stopped
OBS media input. It cannot prove visual motion if the Quest continues encoding
valid repeated pixels, so the moving timestamp/color check remains part of a
long-session rehearsal.

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

## Complete real-device and Twitch acceptance test

The Mac transport has an automated synthetic-stream check during development,
but the following items require the physical Quest compositor:

1. Open `https://localhost:8081/capture-test.html` for two minutes. Its timestamp
   and health chip must change continuously in OBS.
2. Open ChatIRL, enter immersive AR, and start a Twitch broadcast from the
   dashboard.
3. On a Twitch viewer account, confirm live video contains passthrough,
   tabletop, avatars, hand visualization, and physical object manipulation.
4. Exercise `!join`, `!wave`, `!dance`, `!jump`, `!run`, and `!leave`; confirm
   each local action is visible in the Twitch player after the expected delay.
5. Hold a viewer avatar, send actions, then send `!leave`. Confirm the avatar is
   forcibly released and removed within the existing bounded leave deadline.
6. Use at least two independent viewer accounts. Confirm each command controls
   only its sender's avatar.
7. Run continuously for 60–90 minutes. Every five minutes, move the headset and
   a hand through the avatar scene, record receiver bitrate, check OBS Stats for
   dropped frames, and confirm the Twitch player still shows that motion.
8. During the run, restart the receiver once. Restart capture on Quest if the
   projection/encoder connection does not reconnect automatically; Android must
   request consent for every new projection session.
9. Pass only if there is no unexplained frozen frame longer than five seconds,
   Quest interaction remains comfortable, and end-to-end delay is acceptable.

Already verified on physical Quest 3S: compositor passthrough, hand layer,
WebXR objects/avatars, foreground capture while Quest Browser is immersive, and
native feed reception in OBS. Still requiring the creator's environment:
actual Twitch broadcast through this feed, multi-account behavior, forced leave
while physically held, thermal/performance impact, audio sync, recovery during
interruption, and the 60–90-minute stability run. Audio capture from Quest is
intentionally out of scope; use the OBS microphone path.
