# Development

## Architecture

```text
Twitch OAuth + EventSub WebSocket
              │
              ▼
local Node control server (:8787) ──────► OBS WebSocket (:4455)
              │                                  ▲
              ▼                                  │
IWSDK/Vite HTTPS (:8081) ◄── USB ── Quest Browser│
                                                │
Quest MediaProjection APK ─ H.264/USB ─ receiver ─ UDP/MPEG-TS
```

The Node server binds to `127.0.0.1`. Vite proxies secure same-origin `/chatirl` to backend `/ws`. The receiver stream-copies H.264 into MPEG-TS for OBS; it does not re-encode video.

## Developer commands

```bash
npm run server
npm run dev
npm run typecheck
npm test
npm run build
npm run capture:test
npm run capture:build
```

Release helpers are `npm run setup`, `npm run check`, and `npm run start:holohangout`. The original commands remain available.

## Local data

- `.env` — local credentials and OBS settings.
- `.chatirl/twitch-token.json` — Twitch token, stored with user-only permissions.
- `quest-capture/app/build/` — generated Android output.
