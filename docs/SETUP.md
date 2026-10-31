# First-time setup

HoloHangout supports local launch tooling on Windows and macOS. The complete headset and OBS workflow is verified on macOS with Meta Quest 3S; Windows still requires end-to-end verification on a physical Windows machine.

## 1. Install prerequisites

Install Node.js `22.19.0` (recommended), [OBS Studio](https://obsproject.com/), [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools), and [FFmpeg](https://ffmpeg.org/download.html). Add `adb` and `ffmpeg` to `PATH`. HoloHangout validates Node directly; `nvm` is not required.

With Homebrew:

```bash
brew install node@22 android-platform-tools ffmpeg
```

On Windows, install the same tools using their official installers or a package manager such as `winget`, then open a new PowerShell window and verify:

```powershell
node --version
adb version
ffmpeg -version
```

Enable developer mode for the Quest through the Meta Horizon mobile app. Connect the headset using a USB data cable and approve **Allow USB debugging** inside Quest.

## 2. Prepare HoloHangout

```bash
git clone https://github.com/Harpita-P/ChatIRL-MixedReality.git
cd ChatIRL-MixedReality
npm install
npm run setup
```

The setup command verifies Windows/macOS and Node.js, installs exact dependencies, creates `.env` only when missing, and checks ADB, FFmpeg, the APK, and Quest connectivity. It never overwrites credentials.

Follow [TWITCH.md](TWITCH.md), then [QUEST-OBS.md](QUEST-OBS.md).

## 3. Install HoloHangout Capture once

```bash
adb devices
npm run capture:install:release
```

Alternatively, setup can install the APK after dependencies when an authorized Quest is already connected:

```bash
npm run setup -- --install-apk
```

If the device says `unauthorized`, put on the headset and approve USB debugging, then rerun `adb devices`.

## Daily use

```bash
npm run start:holohangout
```

Or double-click `Start HoloHangout.command` on macOS or `Start HoloHangout.cmd` on Windows. The launcher configures USB forwarding when an authorized Quest is present, starts the local backend, receiver, and WebXR frontend, then opens the dashboard.

Keep the Terminal window open. Press **Control-C** to stop the child processes and IWSDK server.

## Diagnostics

```bash
npm run check
```

Warnings such as a disconnected Quest are expected when the device is unplugged. Errors identify prerequisites required before launch.
