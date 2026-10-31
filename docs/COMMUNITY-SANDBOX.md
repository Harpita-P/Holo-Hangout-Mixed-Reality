# Community Sandbox

Community Sandbox lets a joined Twitch viewer send `!build <description>`. A request bubble appears above that viewer's monster for 15 seconds. The streamer approves it by holding the monster for about 0.4 seconds; only then can an OpenAI request occur. The resulting validated voxel sculpture materializes in the display area and can be grabbed as one object.

## Configure and use

Add this only to your private local `.env` file, then restart HoloHangout:

```dotenv
OPENAI_API_KEY=your_key_here
OPENAI_VOXEL_MODEL=gpt-6-luna
COMMUNITY_SANDBOX_GENERATOR=openai
COMMUNITY_SANDBOX_SESSION_LIMIT=20
```

Open the creator dashboard, select **Start Community Sandbox**, and ask joined viewers to use `!build colorful dragon` or another short object description. Each viewer can have one pending or generating request. Up to five requests can wait, three can be approved/queued, one generates at a time, and unresolved requests expire after 15 seconds. Stopping Sandbox expires pending requests but keeps completed creations and lets an approved generation finish. **Clear Sandbox Objects** removes completed creations after confirmation.

The API key remains in the local Node backend. It is never included in browser bundles, WebSocket messages, Twitch chat, or the repository. Calls use the Responses API with strict Structured Outputs and occur only after physical approval. Costs depend on the configured model and the generated JSON size; the default session allowance is 20 creations.

## No-credit mock test

For a completely offline deterministic test, set `COMMUNITY_SANDBOX_GENERATOR=mock` and restart. The mock generator recognizes dragon, castle, tree, rocket, and heart prompts. Alternatively, turn on dashboard Demo Mode, start Sandbox, expand **Offline mock test**, and add a mock request above a demo monster; that individual request never uses OpenAI even when the normal generator is enabled.

## Limits and current behavior

- Grid: at most 12 × 12 × 12, 300 occupied voxels, and 8 colors.
- World: at most 10 completed creations and one OpenAI generation at a time.
- Prompts: at most 100 characters with conservative local filtering plus OpenAI moderation after approval.
- Renderer: shared cube geometry and palette materials with instanced voxel batches.
- Creations can be pinched, moved, and rotated. Placement is simplified; physically accurate rigid-body stacking is not claimed.
- Simple props, animals, and fantasy creatures are the most reliable. Arbitrary prompts may vary in recognizability.
