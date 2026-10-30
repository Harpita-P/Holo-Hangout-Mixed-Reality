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

## Capture into OBS

The validated capture path remains MQDH USB casting:

1. In MQDH Device Manager, connect the Quest and select **Cast**.
2. Enter ChatIRL's immersive AR session before evaluating the cast.
3. Start with **Original (1:1)**, which was verified to include passthrough,
   virtual content, and hand visualization on Quest 3S.
4. In OBS, add a **Window Capture** source for the MQDH cast window. Crop or
   scale it for the stream layout.
5. Add the streamer's microphone directly in OBS; MQDH does not capture the
   microphone.
6. Record a local rehearsal showing two independent viewers, commands, a hand
   pickup/release, and `!leave` while held before going live.

If passthrough disappears, restart casting after entering AR, return to
Original (1:1), update Horizon OS/Quest Browser/MQDH, and compare USB casting
with MQDH ADB-over-Wi-Fi casting. Quest's standard cast-to-computer window or
on-device recording are diagnostic fallbacks; confirm independently that a
fallback includes passthrough before relying on it for Twitch.

## Architecture boundary

```text
Twitch chat
  -> Twitch EventSub WebSocket (single streamer OAuth)
  -> local Node authority (identity, slots, cooldowns, snapshots)
  -> same-origin WebSocket through :8081
  -> IWSDK Quest client (rendering, animation, direct hand grab)
```

There is intentionally no database, cloud deployment, multi-streamer account
system, viewer OAuth, or gameplay backend in Phase 2. The protocol and slot
authority are structured so capacity and deployment can grow after the
5–10-viewer validation.
