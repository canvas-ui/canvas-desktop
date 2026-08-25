<p align="center">
  <img src="https://raw.githubusercontent.com/canvas-ai/.github/main/banners/canvas-banner_1200x480.jpg" alt="Canvas" width="100%" />
</p>

# Canvas Desktop

Tauri desktop overlay prototype for Canvas

## Install

Download the latest build for your platform from [GitHub Releases](https://github.com/canvas-ui/canvas-desktop/releases/latest):

| Platform | Architecture | Artifact |
| --- | --- | --- |
| Linux | x64 | `.deb`, `.AppImage`, or `.rpm` |
| macOS | Apple Silicon | `.dmg` |
| macOS | Intel | `.dmg` |
| Windows | x64 | `.exe` (NSIS installer) |

Releases are unsigned for now. macOS/Windows may show a gatekeeper warning - open via right-click → Open, or allow in system security settings.

## Requirements

- A running Canvas server (local or remote)
- Log in through the app, or configure the server URL in settings

## FUSE mounts (Linux)

With [canvas-fuse](https://github.com/canvas-ai/canvas-fuse) installed on
`$PATH`, the tray gains a **Mounts** submenu listing your contexts and
workspaces once you're signed in. Toggling an entry spawns one detached
`canvas-fuse` daemon per mount:

- contexts mount read/write at `~/Canvas/Contexts/<workspace>/<id>` — a flat
  view of the context's documents (same shape as the WebDAV transport; a
  derived read-only `.by-schema/` holds the per-schema grouping)
- workspaces mount read/write at `~/Canvas/Workspaces/<name>` (`Home/`,
  `Trees/`, `Trash/`)

Mounts outlive the app (each is its own daemon); **Unmount all** or
`canvas-fuse unmount <path>` tears them down. Optional keys in
`~/.canvas/config/canvas-desktop.json`:

- `fusePath` — path to the canvas-fuse binary if not on `$PATH`
- `mountRoot` — base directory for mounts (default `~/Canvas`)

## Local development

```bash
git clone git@github.com:canvas-ui/canvas-desktop.git
cd canvas-desktop
npm ci
npm run tauri dev
```

**Linux build deps** (Ubuntu/Debian):

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

You also need [Rust](https://rustup.rs/) stable.

## Build locally

```bash
npm ci
npm run tauri build
```

Installers land in `src-tauri/target/release/bundle/`.

## CI / releases

`ci.yml` builds the frontend on every push and PR. `release.yml` builds
installers when a `desktop-v*` tag is pushed.

**Cut a release:**

```bash
# from the stack root — ships desktop if its code moved
./canvas-release.sh --apps desktop --bump patch

# from the monorepo root
npm run release:desktop -- --bump patch
```

That bumps `package.json`, `src-tauri/tauri.conf.json` and `Cargo.toml`
together (release.yml asserts the tag against `tauri.conf.json`), pushes
`desktop-v<version>`, and lets CI build Linux, macOS and Windows via
`tauri-apps/tauri-action`.

**Repo setting required:** Settings → Actions → Workflow permissions → **Read and write**.

**Signing (optional, not configured yet):**

- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
- Windows: custom `signCommand` in `tauri.conf.json`

## Submodule in canvas-server

```bash
git submodule update --init src/ui/desktop
```

## Licence

Copyright (C) 2026 Jozef Melich.

Canvas Desktop is licensed under the **[AGPL-3.0-or-later](LICENSE)** and under no
other terms. No commercial exemption is offered for this component, to anyone.
The Canvas clients stay free software in all cases.

Contributing needs no CLA here, only a DCO sign-off (`git commit -s`). See
[CONTRIBUTING.md](CONTRIBUTING.md). The dual-licensed Canvas components are
listed in [NOTICE](NOTICE).
