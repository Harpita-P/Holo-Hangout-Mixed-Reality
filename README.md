# HoloHangout

### A New Dimension of Shared Live Experiences

HoloHangout brings Twitch viewers into a streamer's mixed-reality world as animated characters, letting creators physically interact with their communities in real time.

[Get Started](#quick-start) · [Download Source](https://github.com/Harpita-P/ChatIRL-MixedReality/archive/refs/heads/main.zip) · [Quest Capture APK](release/HoloHangout-Capture.apk) · [Twitch Setup](docs/TWITCH.md) · [Quest + OBS Setup](docs/QUEST-OBS.md) · [Chat Commands](docs/COMMANDS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

> HoloHangout is a local-only Windows and macOS creator toolkit. It does not upload your Twitch credentials, headset feed, or OBS configuration to a HoloHangout cloud service.

## What it does

### For streamers

- Bring Twitch viewers into a Quest mixed-reality tabletop.
- Meet viewers as animated monsters with names and live speech bubbles.
- Physically grab characters, give community shoutouts, and play the blaster challenge.
- Broadcast actual Quest passthrough, hands, avatars, and interactions through OBS.
- Open Community Sandbox and physically approve viewer ideas that become grabbable voxel sculptures.

### For viewers

- Join from ordinary Twitch chat with `!join`; no headset or installation needed.
- Appear as an animated character with individual actions.
- Chat through in-world speech bubbles and participate in community challenges.
- Submit a miniature creation idea with `!build <description>` while Community Sandbox is open.

## Requirements

- Windows 10/11 or macOS.
- Node.js `22.19.0` recommended; compatible ranges are enforced by `package.json`.
- Meta Quest 3 or Quest 3S with developer mode and USB debugging enabled.
- A USB data cable, Android Platform Tools (`adb`), and FFmpeg.
- OBS Studio 28 or newer with its built-in WebSocket server enabled.
- A Twitch account and a locally configured Twitch developer application.

## Quick start

Install Node.js directly from [nodejs.org](https://nodejs.org/) and confirm `node --version` works. `nvm` is not required. Install [OBS Studio](https://obsproject.com/), [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools), and [FFmpeg](https://ffmpeg.org/download.html), ensuring `adb` and `ffmpeg` are available on `PATH`.

On both macOS Terminal and Windows PowerShell:

```bash
git clone https://github.com/Harpita-P/ChatIRL-MixedReality.git
cd ChatIRL-MixedReality
npm install
npm run setup
```

Complete the guided [Twitch setup](docs/TWITCH.md) and [Quest + OBS setup](docs/QUEST-OBS.md), then install the companion once:

```bash
npm run capture:install:release
```

Start every HoloHangout session with one command:

```bash
npm run start:holohangout
```

You can instead double-click **Start HoloHangout.command** on macOS or **Start HoloHangout.cmd** on Windows. Keep the launcher window open; press **Control-C** to stop everything cleanly.

The macOS + Quest 3S workflow has been tested on real hardware. Windows launch, dependency checks, ADB forwarding, Android builds, and process cleanup now have native code paths, but the complete Windows + Quest + OBS workflow still requires verification on a physical Windows machine.

Run a readiness report at any time:

```bash
npm run check
```

## The four-step streamer flow

1. **Connect Twitch** — open `http://localhost:8787` and authorize your channel.
2. **Enter Your World** — open `https://localhost:8081/` in Meta Quest Browser and select **Enter AR**.
3. **Go Live on Twitch** — start HoloHangout Capture, confirm its native feed in OBS, and use the dashboard's **Start Stream** action.
4. **Encourage Chat to Join** — ask viewers to type `!join` in Twitch chat.

## Two components, one toolkit

- **HoloHangout World** is the WebXR mixed-reality experience opened in Meta Quest Browser.
- **HoloHangout Capture** is the native Quest companion that sends the headset compositor view to the local OBS pipeline.

The Capture APK does not contain Twitch credentials or a stream key. Android requires explicit screen-capture consent every session.

## How broadcasting works

```text
Twitch chat ───────────────► local HoloHangout backend ─► Quest WebXR world
                                ▲                              │
                                │                              ▼
Streamer dashboard ◄────────────┘                     Quest compositor
                                                               │
                                                               ▼
Twitch viewers ◄── Twitch ◄── OBS ◄── local receiver ◄── HoloHangout Capture
```

Everything stays on the streamer's computer and USB-connected Quest except Twitch's normal OAuth, chat, and livestream services.

## Documentation

- [Complete first-time setup](docs/SETUP.md)
- [Twitch application and authorization](docs/TWITCH.md)
- [Quest Capture and OBS](docs/QUEST-OBS.md)
- [Viewer chat commands](docs/COMMANDS.md)
- [Community Sandbox setup and limits](docs/COMMUNITY-SANDBOX.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Architecture and development](docs/DEVELOPMENT.md)
- [Third-party notices](docs/THIRD-PARTY-NOTICES.md)

## Contributing

Please run `npm run check`, `npm run typecheck`, `npm test`, and `npm run build` before proposing changes. Keep credentials, tokens, recordings, generated Android outputs, and signing keys out of Git.

## License and acknowledgements

HoloHangout is open-source software released under the [MIT License](LICENSE). Dependencies and bundled assets remain subject to their applicable licenses; see [Third-party notices](docs/THIRD-PARTY-NOTICES.md).
