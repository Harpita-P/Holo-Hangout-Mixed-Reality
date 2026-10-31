# HoloHangout Phase 4 deployment

Phase 4 keeps two intentionally separate processes:

- The hosted platform handles Twitch OAuth, EventSub webhooks, streamer dashboards, and Quest world state.
- The existing local control server handles the USB Quest receiver, OBS, and the Twitch broadcast output.

The hosted backend never needs access to OBS, ADB, the Quest video feed, or a Twitch stream key.

## Local hosted-platform development

1. Copy `.env.platform.example` to `.env.platform` and use local values:

   ```text
   HOLOHANGOUT_PUBLIC_URL=http://localhost:8788
   HOLOHANGOUT_FRONTEND_ORIGIN=https://localhost:8081
   TWITCH_REDIRECT_URI=http://localhost:8788/auth/twitch/callback
   ```

2. Add the same redirect URI in the Twitch developer console.
3. Add these frontend-only values to `.env.local`:

   ```text
   VITE_HOLOHANGOUT_API_URL=http://localhost:8788
   VITE_HOLOHANGOUT_WS_URL=ws://localhost:8788/ws
   ```

4. Start the hosted backend and Vite/IWSDK frontend in separate terminals:

   ```bash
   npm run server:platform
   npm run dev
   ```

The original local demo workflow remains available with `npm run server` and `npm run dev`.

## Production frontend: Vercel

The repository includes `vercel.json`. Create a Vercel project from this repository and set:

```text
VITE_HOLOHANGOUT_API_URL=https://<backend-domain>
VITE_HOLOHANGOUT_WS_URL=wss://<backend-domain>/ws
```

Vercel runs `npm run build` and publishes `dist/`. The `/dashboard` and `/world/*` routes rewrite to the Vite entry page, and Vercel supplies the HTTPS origin required by WebXR.

## Production backend: persistent Node host

`render.yaml` describes the smallest supported Render deployment: one persistent Node web service plus a 1 GB mounted data disk. An equivalent persistent Node host is also supported.

Configure:

```text
HOLOHANGOUT_PUBLIC_URL=https://<backend-domain>
HOLOHANGOUT_FRONTEND_ORIGIN=https://<frontend-domain>
HOLOHANGOUT_DATA_DIR=/var/data/holohangout
TWITCH_REDIRECT_URI=https://<backend-domain>/auth/twitch/callback
TWITCH_CLIENT_ID=<server-side>
TWITCH_CLIENT_SECRET=<server-side>
HOLOHANGOUT_SESSION_SECRET=<high-entropy server-side secret>
HOLOHANGOUT_TOKEN_KEY=<independent high-entropy server-side secret>
TWITCH_EVENTSUB_SECRET=<independent high-entropy server-side secret>
```

Never prefix secrets with `VITE_`. Twitch access and refresh tokens are AES-256-GCM encrypted before being written to the persistent disk.

Health check: `GET https://<backend-domain>/health`.

## Twitch application

Register one confidential Twitch developer application with this exact production redirect URI:

```text
https://<backend-domain>/auth/twitch/callback
```

HoloHangout requests:

- `user:read:chat`
- `user:write:chat`
- `clips:edit`

The backend uses EventSub webhooks for hosted chat delivery. Each broadcaster gets an isolated subscription, participant manager, leaderboard, demo state, Hangout Moments history, world ID, and authenticated control session.

## Streamer flow

1. Visit the Vercel frontend and select **Connect with Twitch**.
2. Complete Twitch authorization.
3. Open the generated dashboard.
4. Select **Open World** or copy the secured world URL to Meta Quest Browser.
5. Select **Enter AR** in the existing IWSDK experience.
6. Viewers use `!join` and the existing HoloHangout commands in that streamer's Twitch chat.

World launch credentials are scoped to one world, expire after eight hours, and are carried in the URL fragment so they are not sent in ordinary HTTP requests.

## Quest Capture and OBS

The verified capture path is unchanged:

1. Install the existing Quest Capture APK.
2. Connect Quest by USB.
3. Configure the existing ADB reverse ports and start the local receiver.
4. On Quest, approve **Start Capture → Entire View**.
5. Use **Quest Capture Feed** in the existing OBS scene.
6. Start and stop Twitch streaming from the existing local HoloHangout control dashboard.

MQDH remains the fallback. Hosting does not remove the USB/ADB or local receiver requirement.
