# Twitch setup

Each local installation connects one broadcaster account. Viewer identity and commands are obtained dynamically from that broadcaster's Twitch chat; there is no hardcoded channel.

## Register a Twitch application

1. Enable two-factor authentication on the streamer Twitch account.
2. Open the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
3. Register an application named `HoloHangout Local` (the name must be unique).
4. Add this exact OAuth redirect URL:

   ```text
   http://localhost:8787/auth/twitch/callback
   ```

5. Choose an appropriate application category and create a client secret.
6. Add the Client ID and Client Secret to the private `.env` file:

   ```dotenv
   TWITCH_CLIENT_ID=your_client_id
   TWITCH_CLIENT_SECRET=your_client_secret
   TWITCH_REDIRECT_URI=http://localhost:8787/auth/twitch/callback
   ```

Never commit `.env` or share the Client Secret. HoloHangout stores the refreshable user token locally at `.chatirl/twitch-token.json` with user-only permissions.

## Authorize the broadcaster

1. Run `npm run start:holohangout`.
2. Open `http://localhost:8787`.
3. Under **1. Twitch Connection**, select **Connect / Reconnect Twitch**.
4. Approve `user:read:chat`, `user:write:chat`, and `clips:edit`.

The first two permissions receive chat and send join guidance. `clips:edit` powers Hangout Moments. Tokens are validated and refreshed automatically. Password changes, revoked connections, expired refresh tokens, or regenerated application secrets can require reauthorization.
