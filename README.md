# ChatIRL — Phase 1 MR validation

This phase proves the smallest ChatIRL mixed-reality loop on Meta Quest 3S:

- WebXR `immersive-ar` passthrough in Meta Quest Browser
- tracked hands and a regular thumb–index pinch
- direct one-hand grabbing through Meta Immersive Web SDK (IWSDK)
- a manually repositionable 62 × 44 cm virtual tabletop
- one grabbable 10.5 cm validation cube

There is intentionally no Twitch integration, backend, avatar system, physics,
or automatic surface detection yet.

## Prerequisites

- Meta Quest 3S with an up-to-date Meta Quest Browser
- hand tracking enabled on the headset
- Node.js 22.19.0 (the repository includes `.nvmrc`)
- npm 10+
- the development computer and Quest on the same local network
- Meta Quest Developer Hub (MQDH) plus Developer Mode and a data-capable USB-C
  cable for the recommended capture workflow

IWSDK does not support Node 23. If you use `nvm`:

```sh
nvm install
nvm use
```

## Install and run

From the repository root:

```sh
npm install
npm run typecheck
npm run dev
```

`npm run dev` starts IWSDK's HTTPS development server and managed desktop
emulator. On first use, IWSDK may also download its managed Chromium build.
Keep this terminal running.

The terminal prints URLs similar to:

```text
Local:   https://localhost:8081/
Network: https://192.168.x.x:8081/
```

You can print them again from another terminal with:

```sh
npm run dev:status
```

## Open on Quest 3S

1. Put the Quest and development computer on the same Wi-Fi network.
2. Open the printed **Network** URL in Meta Quest Browser. Do not use the
   computer's `localhost` URL on an untethered headset.
3. The development certificate is local and self-signed. If Quest Browser
   shows a privacy warning, open the advanced option and continue to the site.
   WebXR needs HTTPS; replacing the URL with plain HTTP will prevent AR from
   starting.
4. Select the IWSDK **Enter AR** offer and grant requested XR/hand permissions.
5. The turquoise tabletop should appear about 75 cm in front of you, around
   ordinary desk height, with an orange cube on top.

If the headset cannot reach the network URL, allow incoming connections for
Node on the development computer and check local-network isolation. As a USB
fallback with Android Platform Tools installed:

```sh
adb devices
adb reverse tcp:8081 tcp:8081
```

Then open `https://localhost:8081/` inside Quest Browser and accept the local
certificate warning.

## Hand interaction test

Use a normal direct thumb–index pinch, with your hand physically near the
object. Do not use the palm-facing system-menu pinch.

1. Pinch and hold the turquoise tabletop, move it until it visually aligns
   with a safe physical surface, then release. The cube moves with the table.
2. Bring a hand close to the orange cube.
3. Pinch and hold the cube, move your hand, then open the pinch to release it.
4. Repeat with both hands separately and briefly move a hand out of tracking
   range to expose any device-specific instability.

There is no gravity in this validation slice, so an object remains at the pose
where it is released. Keep the play area clear and do not lean on a surface
that exists only virtually.

## Capture into OBS

MQDH is the primary validation path because Meta supports using it to cast
Quest Browser and WebXR content directly to a desktop.

1. Enable Developer Mode for the Quest and connect it to MQDH. Accept the USB
   debugging prompt in the headset. Use a data-capable USB-C cable.
2. In MQDH, open **Device Manager** and select **Cast** under Device Actions.
3. Start ChatIRL's AR session in Quest Browser before evaluating the cast.
4. Start with **Original (1:1)** to diagnose the unmodified compositor image.
   After that works, use **Cropped (16:9)** for an OBS-friendly frame. Avoid
   Cinematic mode for the first test because it restarts the immersive session
   and renders a wider field of view.
5. In OBS, create a 1920×1080 scene and add a **Window Capture** source for the
   MQDH casting window. Crop or scale it without cutting off the tabletop.
6. Add the streamer's microphone directly to OBS. MQDH casting does not capture
   microphone audio, even when headset/system audio is enabled.
7. Make a local OBS recording before streaming. The recording must show all of:
   the real room, the tabletop and cube, visible hands, cube pickup/movement,
   and release.

For a Twitch rehearsal, add the normal Twitch stream destination only after the
local recording passes. Keep private information out of the passthrough view.

### If passthrough is black or missing

Try these in order:

1. Update Horizon OS, Meta Quest Browser, and MQDH.
2. Stop casting, enter ChatIRL's AR session, and start casting again.
3. Compare USB casting with MQDH's **ADB over Wi-Fi** casting.
4. Return to Original (1:1) and disable OBS cropping to distinguish a cast
   failure from an OBS source/crop problem.
5. Use MQDH's built-in recording or Quest on-device recording as diagnostic
   evidence. These recordings are not a substitute for a live Twitch path.
6. Try Quest's standard cast-to-computer workflow and capture that window in
   OBS. Confirm passthrough independently; do not assume every casting path
   includes camera imagery.

If no live desktop cast shows passthrough plus WebXR content, stop before Phase
2 and reassess the capture/runtime path.

## Project checks

```sh
npm run typecheck
npm run build
```

The desktop IWER emulator can prove scene composition and input wiring, but only
the physical Quest test can validate passthrough, optical hand-tracking quality,
and the final casting path.

## Later-phase invariant

When Twitch participants are added, `!leave` must complete within a short,
bounded time even if the viewer's avatar is currently held.
