# Licensing and attribution review

This file records release blockers; it is not a grant of rights.

## Project license

No root open-source license has been selected. The repository must not be advertised as an open-source release until the owner approves and adds a project license.

## Code dependencies

The directly installed IWSDK packages, Three.js/super-three, Vite, ws, obs-websocket-js, and most development packages report MIT-compatible upstream licenses; TypeScript reports Apache-2.0 and dotenv reports BSD-2-Clause. `@meta-quest/metavr` reports the Meta Platform Technologies SDK License and requires separate review. The MIT notice in `vite.config.ts` does not license the entire HoloHangout repository. Before publishing, retain all required upstream notices and confirm that the Meta SDK license permits the intended distribution.

## Models and environment assets

The repository contains monster models under `public/monsters/` and `assets-source/chatirl-monsters/`, plus environment models under `public/environment/` and `assets-source/environment/`. No accompanying license or proof of redistribution rights was found during release preparation. The runtime GLTF metadata identifies Blender's Khronos exporter but contains no copyright statement.

The owner must locate the original marketplace/download licenses and confirm that redistribution of source GLTF files in a public repository is permitted. If it is not, remove restricted source assets from the public release and provide a user-supplied asset step or obtain suitably licensed replacements.

## Native APK

`release/HoloHangout-Capture.apk` is built from this repository's Android source and debug-signed for sideload testing. Do not represent it as a Meta Horizon Store-signed build. Store distribution requires an approved permanent signing identity and relevant Meta agreements.
