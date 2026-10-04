# Canvas Desktop

Canvas Desktop hosts the existing `canvas-web` application in Tauri. The same
React routes, screens, editors, settings, themes and services are bundled into
both applications. Desktop does not maintain a second application UI.

## Run

Keep `canvas-web` and `canvas-desktop` as sibling checkouts:

```sh
pnpm --dir ../canvas-web install --frozen-lockfile
pnpm install
pnpm run tauri dev
```

Choose a saved CLI remote or enter the Canvas server address, then use the
standard Canvas login screen. **Server** in the bottom-right changes connections.
A server change reloads the app to dispose sockets and singleton API clients.
Credentials and UI preferences in the webview are scoped to the selected server;
logging out does not import the shared remote token again on the next launch.
For saved remotes, successful web login updates their token in the native store.

The main UI does not invoke PM2, mount status or mount startup during login.
Existing native tray mount management remains available for saved plans. The
old setup/multi-canvas prototype is not mounted. Desktop-specific application
views and mount onboarding will follow the shared UI baseline.

## Shared frontend build

The Vite build imports `../canvas-web/src` directly and uses its public assets.
CI checks out the pinned web v2.14.15 commit beside desktop. The desktop package
carries the web frontend dependencies alongside Tauri. A
standalone desktop checkout needs its sibling web checkout for builds; installed
packages embed everything and do not need those source directories.

The host supplies the selected API URL before importing the web application.
A desktop-only Vite adapter supplies the API URL and selected-server origin to
share links and agent WebSocket fallbacks. The web source is unmodified. Service-worker registration is
disabled in desktop, where native packages own frontend updates. Excalidraw fonts,
PDF workers and wallpapers ship with the bundle.

## Shared configuration

Named remote credentials live in `~/.canvas/config/remotes.json`, using the CLI's
`url`, `auth.token`, and optional `device.token` shape. Existing remote metadata
is preserved. Selecting a remote in desktop does not change the CLI's bound
remote. `CANVAS_USER_HOME` overrides the configuration home for all integrations;
on Windows the existing CLI convention is `~/Canvas`.

The new versioned plan lives in `~/.canvas/config/desktop.json`. The old
`canvas-desktop.json` experiment is ignored; no credentials are imported from
it. Files are atomically replaced with owner-only permissions on Unix. Stop
configured mounts before changing a plan, to avoid stranding active mounts.

Each export has one PM2 process and a separate FUSE state/cache:

- `<root>/<remote>/<workspace>/Home`: direct 1:1 workspace Home export.
- `<root>/<remote>/<workspace>/Trees/<tree>`: one context or directory tree.
- `<root>/<remote>/<workspace>/Contexts`: that workspace's context views.

PM2 names follow `canvas-desktop-<remote>-<workspace>-Home`, `...-Contexts`,
or `...-Trees-<tree>`. Name components are escaped to avoid collisions and
unsafe log filenames. Start/Restart replaces legacy hashed services with the
readable name; Stop and status also recognize legacy services. Mount and mirror
share the same service identity.

Mount only provides a live read/write filesystem. Mirror is Home-only: FUSE
pins all files, retains an offline cache, uploads writes, and handles remote
removals through its mirror trash. This is a FUSE-backed mirror, not a separate
watcher syncing an ordinary folder. Trees and Contexts remain live mounts.
Git exports are deferred.

Desktop recovers the user's interactive login-shell PATH for PM2, Node and
canvas-fuse discovery, including when launched from the desktop menu. Discovery
falls back to the inherited PATH if shell startup fails or exceeds three seconds.
The same PATH is supplied to subprocesses and PM2's FUSE child.

PM2 runs foreground FUSE processes, without `--detach`. On Unix the child runs
through `/usr/bin/env -u CANVAS_SERVER -u CANVAS_API_TOKEN`, preventing stale or
empty daemon environment overrides from replacing the selected remote. Desktop
also supplies the remote's validated HTTP(S) URL explicitly; tokens still come
from the shared remote store. It stores generated
process definitions under `~/.canvas/var/desktop-pm2/`. Tokens are never written
to those definitions or passed in process arguments. Automatic crash restart
is disabled to avoid remount loops over a stale kernel mount; Restart performs
cleanup before starting again. PM2 OS-login startup is not configured here.

## Verification

```sh
npm run build:frontend
npm test
npm run test:ui # requires Google Chrome; fixtures only, screenshots in /tmp
cd src-tauri
cargo test --lib
```

Packaging FUSE/PM2, OS startup integration and broader native platform validation
remain desktop follow-up work.

## Automatic builds

Every pull request and push to `main` builds native installers for Linux x64,
Windows x64, macOS Apple Silicon and macOS Intel. The shared
`.github/workflows/build.yml` workflow can also be run manually from
GitHub Actions. Download the `canvas-desktop-<target>` artifacts from the run;
they are retained for 14 days. Builds run the native scaffold tests and verify
that the JS, Tauri, Cargo and Cargo lock versions agree.

A release is a version bump pushed to `main`: `pnpm run release patch` keeps
package.json, tauri.conf.json, Cargo.toml and Cargo.lock in step, and
release.yml then creates the `v<version>` GitHub Release and attaches the
installers from the same matrix. Ordinary CI runs only upload workflow artifacts. Linux
produces Debian/RPM/AppImage packages, macOS DMGs, and Windows MSI/NSIS installers.
Builds remain unsigned; FUSE and PM2 are still external prerequisites, and
building a platform installer does not establish filesystem-mount support there.

## Linux / NVIDIA blank window

Before GTK/WebKit starts, desktop defaults `WEBKIT_DISABLE_DMABUF_RENDERER=1`
and `WEBKIT_DISABLE_COMPOSITING_MODE=1` to avoid blank webviews with proprietary
NVIDIA drivers. Explicit values for either variable are preserved. When
`CLUTTER_BACKEND=x11` is set, desktop also defaults `GDK_BACKEND=x11`; an explicit
GTK backend setting takes precedence. These defaults apply only on Linux.

For an older build, launch with the same workaround:

```sh
GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run tauri dev
```

For an installed app, replace `npm run tauri dev` with `canvas-desktop`. Quit
any existing tray instance before relaunching. The fallback disables accelerated
WebKit compositing; set `WEBKIT_DISABLE_COMPOSITING_MODE=0` to opt back in when
your driver supports it.

## Rebuilding the desktop UI

`npm run build` builds the frontend, embeds it in a native release executable,
and creates installers under `src-tauri/target/release/bundle`. For a Linux
Debian installer only, use `npm run build -- --bundles deb`. `npm run
build:frontend` only updates `dist`; it does not replace an installed desktop app.

`npm run tauri dev` loads the local Vite frontend. A packaged app loads the
frontend embedded when that executable was built, and the CLI desktop launcher
uses its downloaded release. Quit the existing tray instance before launching
a rebuilt executable or installing the new package. Check the version footer
and the “Add or sign in to a remote” form to identify the new scaffold.
