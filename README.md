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

GitHub Actions builds on every push to `main`, `develop`, or `dev`, and on PRs to `main`.

| Workflow | Trigger | Output |
| --- | --- | --- |
| `build.yml` | push, PR | Per-platform artifacts (7-day retention) |
| `release.yml` | tag `v*` | GitHub Release with installers |

**Cut a release:**

```bash
# bump version in package.json + src-tauri/tauri.conf.json + src-tauri/Cargo.toml
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds Linux, macOS (arm64 + x64), and Windows in parallel via `tauri-apps/tauri-action`.

**Repo setting required:** Settings → Actions → Workflow permissions → **Read and write**.

**Signing (optional, not configured yet):**

- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
- Windows: custom `signCommand` in `tauri.conf.json`

## Submodule in canvas-server

```bash
git submodule update --init src/ui/desktop
```
