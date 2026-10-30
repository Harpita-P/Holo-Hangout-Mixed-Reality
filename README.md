# ChatIRL — Phase 2 Twitch tabletop community

ChatIRL turns Twitch viewers into independently controlled miniature avatars on
the streamer's real tabletop. This phase keeps the Quest 3S mixed-reality and
hand-grab validation from Phase 1, then adds a minimal single-streamer Twitch
chat bridge.

Implemented viewer commands:

- `!join` creates one avatar for the viewer's Twitch user ID.
- `!run`, `!wave`, `!dance`, and `!jump` affect only that viewer's avatar.
- `!leave` bypasses command cooldowns, forcibly releases a held avatar, and
  removes it within a 1.2 second server-side deadline.

The validation scene has ten reusable avatar slots. Ten is the current test
capacity, not a permanent product limit. The server owns identity, slots,
cooldowns, and current behavior; the Quest is the renderer and physical
interaction client.

## Prerequisites

- Meta Quest 3S with current Meta Quest Browser and hand tracking enabled
- Node.js 22.19.0 (`.nvmrc` is included) and npm 10+
- Android Platform Tools for the proven USB/ADB reverse workflow
- Meta Quest Developer Hub (MQDH) for USB casting
- A Twitch account for the streamer and access to the
  [Twitch Developer Console](https://dev.twitch.tv/console/apps)

IWSDK does not support Node 23. With `nvm`:

```sh
nvm install
nvm use
npm install
```

## One-time Twitch app setup

1. In the Twitch Developer Console, register an application.
2. Add this exact OAuth redirect URL:
   `http://localhost:8787/auth/twitch/callback`
3. Select a confidential client type because the local Node server holds the
   client secret.
4. Copy `.env.example` to `.env`:

   ```sh
   cp .env.example .env
   ```

5. Put the app's Client ID and generated Client Secret in `.env`:

   ```dotenv
   TWITCH_CLIENT_ID=your_client_id
   TWITCH_CLIENT_SECRET=your_client_secret
   TWITCH_REDIRECT_URI=http://localhost:8787/auth/twitch/callback
   CHATIRL_PORT=8787
   CHATIRL_ALLOW_DEBUG_COMMANDS=false
   ```

Never commit `.env`. Twitch authorization is stored locally in
`.chatirl/twitch-token.json`, which is also gitignored and written with
user-only file permissions. The implementation requests only
`user:read:chat`, validates the returned token, refreshes it, and reconnects
EventSub when needed. Viewers do not authenticate with ChatIRL.

## Run Phase 2 locally

Use two terminals from the repository root.

Terminal 1 — authoritative Twitch/chat server:

```sh
npm run server
```

Open [http://localhost:8787](http://localhost:8787), select **Authorize /
reconnect Twitch**, and approve the single `user:read:chat` permission. Keep
this terminal running.

Terminal 2 — IWSDK HTTPS app and emulator:

```sh
npm run dev
```

The app runs at `https://localhost:8081/`. The Vite server proxies the
same-origin secure WebSocket path `/chatirl` to the local server, so no second
Quest port or insecure mixed-content exception is required.

Useful checks:

```sh
npm run typecheck
npm test
npm run build
npm run dev:status
```

## Open on Quest 3S over the proven USB path

Connect the headset, accept USB debugging, then run:

```sh
adb devices
adb reverse tcp:8081 tcp:8081
```

Only port 8081 needs to be reversed. In Meta Quest Browser, open:

```text
https://localhost:8081/
```

Accept the local development certificate warning, select **Enter AR**, and
grant the requested hand/XR permissions. WebXR immersive AR requires a secure
context, so do not replace HTTPS with HTTP.

The tabletop and orange Phase 1 cube should still appear. Viewer slots remain
hidden until chat participants join. A small browser badge reports whether the
local backend and Twitch EventSub are connected.

## Live Twitch validation

With both processes running and the streamer authorized:

1. A viewer sends `!join` in the streamer's Twitch chat. Their named, colored
   avatar should appear on the table.
2. A second viewer sends `!join`; they must get a different avatar.
3. Have each viewer send different commands. An action must affect only its
   sender's avatar.
4. Directly pinch a viewer avatar. While held, physical hand movement overrides
   its command animation. Release it and it settles back onto the tabletop.
5. While still holding an avatar, have its viewer send `!leave`. The grab must
   end and the avatar must disappear within 1.2 seconds.
6. Verify duplicate `!join` messages do not create duplicate avatars and an
   eleventh participant is declined while all ten validation slots are full.

The local control page can pause new joins or clear all current avatars. It is
bound to `127.0.0.1`; it is not an internet-facing admin service.

### Local command simulation (optional)

For a rehearsal without writing into Twitch chat, set
`CHATIRL_ALLOW_DEBUG_COMMANDS=true` in `.env`, restart `npm run server`, and
send a local-only test command:

```sh
curl -X POST http://localhost:8787/debug/chat \
  -H 'content-type: application/json' \
  -d '{"userId":"test-1","displayName":"TestViewer","text":"!join"}'
```

Change `text` to any supported command. Disable this endpoint during a real
stream.

## Hand interaction and tabletop placement

Use a normal direct thumb–index pinch close to the object, not the
palm-facing system-menu gesture.

1. Pinch the turquoise tabletop to align the whole community with a safe real
   surface, then release.
2. Pinch the orange cube to confirm the Phase 1 interaction still works.
3. Pinch an active viewer avatar, move it, and release it. Command animations
   pause while it is held.

There is no gravity in this phase. Keep the physical area clear and do not lean
on a surface that exists only virtually.

## Live streaming architecture

The reliable WebXR broadcast path is:

```text
Quest compositor (passthrough + hands + ChatIRL)
  -> MQDH USB Cast window
  -> OBS scene and audio mixer
  -> Twitch RTMP ingest
```

The WebXR page cannot capture passthrough pixels: Meta Quest Browser supplies
passthrough as a system-composited layer. Capturing the browser canvas would
therefore produce virtual content without the real room. MQDH is retained
because it exports the actual compositor image that was validated on the Quest
3S.

Direct Quest-to-Twitch streaming is not implemented in this WebXR phase. Meta's
native Android MediaProjection API can capture the headset display with user
consent, but using it would require a separately installed native Quest app and
an on-device encoder/RTMP client. It is not callable from this browser app.

### One-time OBS setup

Use OBS Studio 28 or newer; obs-websocket is built in.

1. In OBS, open **Settings → Stream**, select Twitch, and connect the streamer
   account. ChatIRL never reads or stores the Twitch stream key.
2. Run OBS's Auto-Configuration Wizard, then use these conservative first-live
   settings:

   - 1280×720 at 30 FPS
   - hardware encoder when available
   - CBR, 3000 Kbps video bitrate
   - 2-second keyframe interval

   After a stable rehearsal, 1080p30 at 4500 Kbps is a reasonable next step.
3. Grant OBS macOS **Screen Recording** and **Microphone** permissions. On macOS
   13+, use **macOS Screen Capture**, not the legacy Window Capture source.
4. Create an OBS scene named `ChatIRL Live`.
5. Start MQDH USB casting in **Original (1:1)**. In the OBS scene, add a macOS
   Screen Capture source in Window Capture mode, select the MQDH Cast window,
   and name the source `MQDH Cast`.
6. Fit the square Original image inside the canvas or switch MQDH to **Cropped
   (16:9)** only after confirming it does not cut off hands or avatars. Avoid
   Cinematic for the first live stream because it restarts immersive apps and
   increases headset rendering work.
7. Enable MQDH's speaker button if headset/system audio is required. MQDH does
   not capture microphone audio, so add the streamer's microphone separately
   in OBS. Give that source an easy name such as `Streamer Mic`.
8. In **Tools → obs-websocket Settings**, enable the server, retain port 4455,
   keep authentication enabled, and copy the generated password.

Update `.env`:

```dotenv
OBS_ENABLED=true
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=the_password_from_obs
OBS_SCENE_NAME=ChatIRL Live
OBS_CAPTURE_SOURCE_NAME=MQDH Cast
OBS_MIC_SOURCE_NAME=Streamer Mic
OBS_MIC_SYNC_OFFSET_MS=0
```

Leave `OBS_MIC_SOURCE_NAME` blank if microphone checking and automatic sync
offset are not wanted. If a local recording shows speech ahead of the delayed
Quest image, set `OBS_MIC_SYNC_OFFSET_MS` to a positive delay, restart the
ChatIRL server, and repeat the clap test. Do not guess the final value; MQDH
latency varies with resolution, bitrate, USB/network conditions, and computer
load.

### Repeatable go-live sequence

1. Connect the Quest over USB and run `adb reverse tcp:8081 tcp:8081`.
2. Start the ChatIRL server and IWSDK app.
3. Enter ChatIRL AR on Quest and confirm Twitch chat is connected.
4. Start MQDH Cast and visually confirm the cast contains the room, tabletop,
   avatars, and hands.
5. Open OBS. The `ChatIRL Live` scene must show the same MQDH image and the
   microphone meter must move.
6. Open `http://localhost:8787`. The Broadcast card checks the OBS connection,
   scene, MQDH source, and optional microphone source.
7. Select **Start Stream**. ChatIRL switches OBS to `ChatIRL Live`, applies the
   configured microphone delay, and starts the already-configured Twitch
   output. The button remains disabled until Twitch chat and OBS preflight are
   ready.
8. Select **Stop Stream** on the same dashboard when finished.

Starting MQDH Cast remains one manual action because Meta documents it as an
MQDH Device Manager operation and does not expose a stable public automation API
for WebXR projects. Automating the desktop UI would be fragile and could start a
black or stale capture without a meaningful preflight.

### Latency and synchronization

Chat commands should continue to animate the local avatar immediately. The
viewer sees that result after the MQDH, OBS encode, Twitch ingest, and player
buffer delays. Do not delay avatar commands to match the broadcast—the same
video pipeline delays the visible result for every viewer. Enable Twitch Low
Latency mode and prioritize stable settings over higher resolution.

Run a private/local rehearsal first:

1. Record in OBS without streaming.
2. Speak and clap while moving a hand beside an avatar.
3. Test `!join`, every animation, an avatar pickup, command-while-held, and
   `!leave` while held.
4. Review audio/video sync and dropped frames in OBS Stats.
5. Then run a short Twitch test and inspect **Latency to Broadcaster** in the
   Twitch player statistics.

If passthrough disappears, restart casting after entering AR, return to
Original (1:1), update Horizon OS/Quest Browser/MQDH, and compare USB casting
with MQDH ADB-over-Wi-Fi casting. Quest's standard cast-to-computer window or
on-device recording are diagnostic fallbacks; confirm independently that a
fallback includes passthrough before relying on it for Twitch.

## Phase 2.5 native Quest capture proof of concept

An optional companion APK now provides a direct compositor-video experiment:

```text
Quest compositor
  -> MediaProjection foreground service
  -> hardware H.264 over TCP/ADB reverse
  -> local FFmpeg MPEG-TS relay
  -> OBS Media Source
  -> Twitch
```

This path does not modify or embed the WebXR experience and does not contain a
Twitch stream key. The existing MQDH workflow remains available until the native
feed passes its real-device stability test. Build, installation, OBS setup,
diagnostics, and acceptance steps are in
[quest-capture/README.md](quest-capture/README.md).

The standalone moving-frame check is served at
`https://localhost:8081/capture-test.html` while the IWSDK development server is
running.

## Architecture boundary

```text
Twitch chat
  -> Twitch EventSub WebSocket (single streamer OAuth)
  -> local Node authority (identity, slots, cooldowns, snapshots)
  -> same-origin WebSocket through :8081
  -> IWSDK Quest client (rendering, animation, direct hand grab)

Quest compositor
  -> MQDH Cast
  -> OBS controlled through localhost:4455
  -> Twitch live video
```

There is intentionally no database, cloud deployment, multi-streamer account
system, viewer OAuth, or gameplay backend in Phase 2. The protocol and slot
authority are structured so capacity and deployment can grow after the
5–10-viewer validation.
