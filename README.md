# World of Warcraft Maps and World 3D Explorer

A specialized fork of [noclip.website](https://github.com/magcius/noclip.website) for freely exploring World of Warcraft maps, including unfinished and normally inaccessible areas.

The map selector includes Vanilla, The Burning Crusade, Wrath of the Lich King, and an experimental WoW Forever beta. This fork adds configurable terrain detail, streaming controls, persistent caching and resolution scaling for large landscape views.

## Download and run on Windows

Download the [Forever Beta 4 ZIP](releases/World_of_Warcraft_Maps_and_World_3D_Explorer_Forever_Beta4_Cache_Optimization.zip). The checked-in source is the earlier Vanilla/TBC/WotLK viewer; the Forever beta is currently provided as a separate prebuilt package. The Python server, downloader probe, and CDN manifests used by the Forever package are available in [`tools/wow-forever/`](tools/wow-forever/). The Forever renderer changes have not yet been fully ported back to the TypeScript/Rust source tree.

1. Download the Forever Beta 4 ZIP above (not GitHub's automatically generated source archive).
2. Extract it into a folder on the drive of your choice.
3. Run `START_WOW_FOREVER_EXPLORER.bat`. Python 3 and Microsoft Edge are required.
4. Microsoft Edge opens the viewer at `http://localhost:4173/`.
5. Keep the PowerShell window open while using the viewer. Press Ctrl+C there to stop the server.

An internet connection is needed to fetch map resources that are not already cached. Game assets are not bundled in this update; resource availability depends on the external data service used by noclip.website.

The launcher creates a dedicated Edge profile in `WoW_Archaeology_BrowserData` and a verified Forever CDN cache in `WoW_Forever_CDN_Cache`, next to the program. Keep both directories when updating. These directories are not included in the downloadable package or tracked in Git. Cached resources still need parsing and GPU upload when loaded again; caching does not make loading instantaneous or guarantee that an entire map is available offline.

The experimental Forever beta includes terrain and water for Zephras Isle, Eastern Kingdoms and Kalimdor. It enables M2/WMO objects on the continental maps, and attempts to show shared indexed models on Zephras tile (28,26). Other Zephras objects and assets missing from the pinned CDN manifests remain unavailable. The CDN dataset is pinned to `wow_classic_beta 1.60.1.69893`.

## Features

- WoW-only map selection and optional atmospheric fog.
- Adjustable view distance and resident tile radius.
- Terrain-first streaming, with M2/WMO objects requested within the object radius.
- High, Low, Ultra and Extreme terrain geometry detail.
- Continental terrain mode: one terrain draw call per distant ADT, using the Extreme index buffer and the tile's dominant base texture. Local texture layers and terrain shadow maps are sacrificed for lower rendering overhead.
- Optional distant texture mip reduction.
- Render scale from 33% to 100%, with Bilinear, Sharp and Edge-adaptive filters. These are custom spatial filters, not NVIDIA DLSS or the official AMD FSR implementation.
- Saved viewer settings and loading/cache diagnostics.

Performance gains depend on the scene, hardware and selected settings. The lower-detail modes intentionally trade visual accuracy for speed.

## Controls

Drag the mouse to look around, use WASD to move, hold Shift to move faster and use the mouse wheel to adjust speed. Press Z to show or hide the interface. Open **World Explorer Settings** for this fork's rendering and streaming controls.

See [the Italian guide](public/README_ITA.txt) for detailed settings and [the upstream documentation](README_UPSTREAM.md) for additional controls.

## Build from source

The source repository is not a ready-to-run Windows package. You need Node.js, pnpm and Rust installed through rustup, as described in the upstream guide.

From the repository root, to build the earlier Vanilla/TBC/WotLK viewer:

```sh
pnpm install
rustup target add wasm32-unknown-unknown
cd rust
cargo install cargo-run-bin
cargo bin --install
cd ..
pnpm build
```

The output is in `dist/`; its launcher files are copied from `public/`. For development with optimized Rust, use `pnpm start:release`. This source build does **not** reproduce the prebuilt Forever Beta 4 ZIP yet.

## Credits and license

Built on noclip.website by Jasper St. Pierre and its contributors. Their renderer, format support and reverse-engineering work are the foundation of this fork. Original third-party credits are retained in [README_UPSTREAM.md](README_UPSTREAM.md). The original [LICENSE](LICENSE) is preserved.

This independent fork was developed with assistance from OpenAI ChatGPT/Codex. It is not an official Blizzard or noclip.website release. World of Warcraft and its game assets belong to their respective rights holders.

Report issues with this fork in this repository. The contribution policies in the preserved upstream README describe the original project, not this independent fork.
