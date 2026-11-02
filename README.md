# canvas · desktop

The desktop foundation is a small, context-first Tauri shell. The main menu,
canvas windows, and toolbox are independent components and native surfaces.
The full `canvas-web` application is still bundled for management screens and
advanced editors, but it is loaded only when you open a web route.

## Run

Keep `canvas-web` and `canvas-desktop` as sibling checkouts:

```sh
pnpm --dir ../canvas-web install --frozen-lockfile
pnpm install
pnpm run tauri dev
```

Choose a saved remote or a server, then sign in with email/password or an API
token. “More sign-in options” opens the shared web login. The main menu becomes
a compact native window; one content canvas opens for the selected tree path,
and the toolbox has its own launcher window beside it. Closing the main menu
keeps the tray running. The tray provides menu, mounts, minimize all, settings,
logout, restart UI, and two quit controls. **Quit** leaves mounts running.
**Quit and unmount all mounts (N)** stops desktop-managed mount processes and
unmounts the current user's Canvas FUSE mounts before exiting. The count refreshes
in the background. If cleanup fails, Canvas stays open and displays the error.

Every native window is frameless: the canvas tab strip is its title bar (drag it,
double-click to maximize, window buttons on the right, invisible resize handles
along the edges). Web pages open *inside* a canvas: a link, a saved tab or the
globe button opens a tab in that canvas by default; **shift+click opens it beside
the canvas** as a new tiled window. Each page runs in its own native webview
below the canvas chrome, with no Canvas credentials or IPC, and reports its title
and address back to the tab strip. `target=_blank` becomes another tab.

The default canvas of a path is the web UI's own canvas page for that path,
rendered inside the window through an in-memory router (the webui's strip
trick): the address bar, document list, layer widgets, renderers and editors
come along unchanged. Navigating to another tree path inside it switches the
desktop context; any other route (a document, settings, agents) turns the tab
into a *web tab* with its own location and back stack. "Open to the side" from
any webui list opens a desktop tab, or a new window on shift.

`pnpm dev` also provides a browser preview at `http://localhost:1420`. In this
preview, native windows are represented as panels in one desktop. It uses the
same components, state, and real server queries. Test data is only provided by
the verification fixture, never by the application.

## Working with contexts

- M0 is the application menu; M1 lists workspaces; M2 navigates a workspace tree.
- Selecting a path restores its windows, tabs, active tabs, and arrangement.
- Context queries use the selected workspace, tree, tree type, and path. Notes,
  files, emails, messages, and saved tabs use the existing server schema filters.
- A single socket in the menu host refreshes visible context content on server
  document/tree events. Each canvas also has manual refresh and search.
- The toolbox opens new windows by default. Enable **as tab** to add a view to the
  focused window. A tab can be detached into its own native window.
- Columns, grid, and focus layouts use configurable gaps. Native bounds and
  monitor names are saved and clamped to an available monitor on restoration.
- Context/global toolbox mode persists across navigation. Global mode currently
  provides a clock and agent launcher. The agent task form uses the existing API.

The palette uses warm paper surfaces and dark green-neutral controls. Desktop
preferences switch the menu between a left sidebar and floating top bar, and
adjust the gap. The shared web theme engine is retained on web routes; desktop
uses semantic CSS tokens ready for a later theme adapter.

While a Canvas window has focus, **Ctrl+Alt+Left** cycles M2 → M1 → M0 → hidden,
**Ctrl+Alt+Space** toggles the toolbox, **Ctrl+Alt+A** opens agents, and **Escape**
dismisses panels. On KDE Plasma, Ctrl+Alt+0/1/2 opens M0/M1/M2 globally and Ctrl+Alt+Left cycles them. Reassign these defaults in Plasma System Settings → Shortcuts → KWin. The menu is present on every virtual desktop; toolbox shortcuts work in focused Canvas windows.

## Local state and extension points

Layout keys include workspace, tree, tree type, and normalized path. The webview
storage is isolated by server and account. Layout edits are saved locally and
shared between native webviews; no server metadata is overwritten. Native window
geometry lives in `~/.canvas/config/desktop-windows.json`, separately from mount
configuration. Up to 24 windows are accepted per path and inactive webviews are
bounded. Screens too small for the requested tiles produce an actionable error.

Canvas positions, client sizes, normal bounds and maximized state are saved per
server/account/path/window. The menu remembers bounds per account and placement;
the toolbox remembers them per path. Expanded and collapsed controls have separate
bounds, so opening a panel restores its last size. Drag the toolbox by its header
(or the margin around the collapsed launcher).

On KDE Plasma the shell talks to KWin over the session bus (short KWin scripts,
`src-tauri/src/desktop/kwin.rs`). Each saved window also records its virtual
desktop(s) and compositor output; a canvas moved to desktop 6 returns to desktop 6
when its path is opened again, falling back to the desktop at the same position
and otherwise staying on the current one. On Wayland, where GTK can neither read
nor set toplevel positions, placement, tiling and maximize state are applied by
KWin as well, and re-shown windows get their saved placement back. Set
`CANVAS_DESKTOP_KWIN=0` to disable the bridge. Other Linux desktops keep native
placement without virtual desktops.

Rust records native moves/resizes directly and coalesces atomic file writes on a
background thread. Closing/hiding surfaces captures their final bounds, and quitting
flushes pending changes. Focus changes, tabs, toolbox toggles and returning to a
path preserve manual placement. New canvases cascade without rearranging existing
ones; choosing Columns/Grid/Focus or changing the gap explicitly retiles them.
Saved monitor names, work areas and scale factors support restoring logical sizes
after DPI/origin changes, with an on-screen fallback if a display is disconnected.
Existing version-1 layout files remain readable.

Components live under `src/components/{main-menu,canvas-window,toolbox,settings}`.
Each owns its view and stylesheet. The host/state contract is
`src/shell/integration.ts`; pure layout operations are in `src/shell/model.ts`;
frameless window chrome (drag, resize edges, window buttons) is `src/shell/chrome.tsx`.
Page webviews are managed by `src-tauri/src/desktop/urls.rs`; on Linux the window's
GTK box allocates the measured chrome height to the host and the remaining
height to the website, including after tab detachment and window resizing.
Other platforms place the page by bounds.
Capabilities are granted per webview label (`main`, `canvas-*`, `toolbox`), so page
webviews (`url-*`) never reach the IPC layer.
See [component integration](src/components/README.md) for extension details.

`window.__CANVAS_DESKTOP_UI__` exposes a versioned, transport-independent
`snapshot()` / `dispatch(action)` interface. It is an adapter boundary for UI
agents, not a running MCP server. Snapshots contain layout state, not credentials
or document bodies. External browser windows have no Canvas surface capabilities.

This foundation does **not** yet assign windows to KDE/GNOME virtual desktops,
provide a remote-control PWA/phone pairing, sync layouts between devices, or
implement context-bound mode. Wayland positioning remains subject to the
compositor. Multi-monitor math is tested; real mixed-DPI, hot-plug, and
KDE/GNOME workspace behavior still need desktop-session validation.

## Performance and verification

Menu, tab, and toolbox state changes happen locally, without waiting for Rust or
HTTP. Pages, applets, editors and the full web application load on demand.
One hidden renderer preloads the shared UI for the next canvas. It stays unbound
until needed, loads no documents, and starts no applets. Logical frame IDs retain
their geometry across renderer assignment and process restarts.
Native layout actions have one authoritative writer in the menu host, with
optimistic updates and acknowledged snapshots in the other windows. Hidden
canvases retain stable scope/router identities when the active tree path changes.
Unchanged layout subtrees retain their React identity, and resizing only updates
the hosted page when it crosses the compact-layout threshold. Terminal output
uses ordered Tauri channels; session lists refresh on lifecycle events rather
than polling. Window reconciliation is serialized and superseded work is
skipped. Title and ordinary focus changes bypass monitor/KWin reconciliation;
already-visible surfaces are not shown again. Geometry writes are debounced
outside interaction handlers. The toolbox has a transparent native window with
a round launcher; embedded Canvas pages use the shared address/search control
and keep content views in its Views menu.

```sh
npm run build:frontend
npm test
npm run test:ui
cd src-tauri
cargo test --lib
cargo build --features desktop-smoke-test --example desktop-smoke
cd ..
node scripts/check-shell.mjs --native
```

Browser checks use a local fixture server and headless Chrome. They cover login,
server isolation, scoped queries, per-path restoration, tabs, detach/close,
search, both menu placements, a narrow toolbox, and the shared-web handoff.
Screenshots are written to `/tmp/canvas-desktop-foundation.png`,
`/tmp/canvas-desktop-top-menu.png`, and `/tmp/canvas-desktop-toolbox-mobile.png`.
The native smoke test uses real Tauri/WebKit windows in Xvfb with a temporary
Canvas home, and exercises surface creation, context hide/restore, tabs,
toolbox state, and geometry persistence. It requires Linux Xvfb/dbus-run-session.
It checks exact bounds through context/panel changes and a full process restart,
including a move immediately before quit. Add `--window-manager` to also run
maximize/minimize restoration checks with `xfwm4` inside the isolated Xvfb session.

The tests log click-to-next-animation-frame timings. These are scheduling
observations on test machines, not input-to-photon measurements or a sub-20 ms
native latency guarantee. The initial software-rendered Xvfb run reached about
32–33 ms, including an explicit composited Xvfb comparison. A real desktop
session and input-to-paint profiling are needed before claiming the latency target.

## Shared frontend build

The Vite build imports `../canvas-web/src` directly and uses its public assets.
CI checks out the pinned web commit beside desktop. A standalone checkout needs
the sibling source; installed packages embed both frontends. The selected API
URL and server-scoped session are initialized before either frontend is loaded.
Service-worker registration is disabled in desktop, where native packages own
updates. Excalidraw fonts, PDF workers and wallpapers ship with the bundle.

A server change reloads the application and disposes its sockets and API clients.
For saved remotes, successful login updates the native token store. Logout does
not reimport that remote token on the next launch. Native mount discovery and
PM2 are only invoked when mount management is opened, not during desktop login.

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

Stable links always download the latest published release:

- Linux x64: [Debian](https://github.com/canvas-ui/canvas-desktop/releases/latest/download/canvas-desktop-linux-x86_64.deb), [RPM](https://github.com/canvas-ui/canvas-desktop/releases/latest/download/canvas-desktop-linux-x86_64.rpm), [AppImage](https://github.com/canvas-ui/canvas-desktop/releases/latest/download/canvas-desktop-linux-x86_64.AppImage).
- macOS: [Apple Silicon](https://github.com/canvas-ui/canvas-desktop/releases/latest/download/canvas-desktop-macos-aarch64.dmg), [Intel](https://github.com/canvas-ui/canvas-desktop/releases/latest/download/canvas-desktop-macos-x86_64.dmg).
- Windows x64: [Installer](https://github.com/canvas-ui/canvas-desktop/releases/latest/download/canvas-desktop-windows-x86_64-setup.exe), [MSI](https://github.com/canvas-ui/canvas-desktop/releases/latest/download/canvas-desktop-windows-x86_64-en-US.msi).
- [SHA256SUMS](https://github.com/canvas-ui/canvas-desktop/releases/latest/download/SHA256SUMS).

Publication verifies and uploads these aliases before marking the release Latest.
Original versioned filenames remain available for pinned downloads.

## Linux / NVIDIA blank window

Before GTK/WebKit starts, desktop applies `WEBKIT_DISABLE_DMABUF_RENDERER=1`
when a proprietary NVIDIA driver is detected via `/proc/driver/nvidia/version`
or `__GLX_VENDOR_LIBRARY_NAME=nvidia`. Accelerated compositing remains enabled
for performance and transparent surfaces. Explicit environment values are
preserved. When `CLUTTER_BACKEND=x11` is set, desktop also defaults
`GDK_BACKEND=x11`; an explicit GTK backend setting takes precedence.

To isolate a driver-related Wayland blank surface, launch an X11 session of the
app with DMA-BUF disabled:

```sh
GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri dev
```

Replace `npm run tauri dev` with `canvas-desktop` for an installed build. Quit
any existing tray instance before relaunching. As a diagnostic last resort,
`WEBKIT_DISABLE_COMPOSITING_MODE=1` requests software compositing; this is an
explicit opt-in because it reduces rendering performance and can affect alpha.

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

### Client certificate remotes

The server picker and mount setup accept PEM certificate/key paths or native file
selection. Configure the identity before the Canvas login screen. The certificate
chain is leaf-first and the RSA/EC private key must be unencrypted and protected
with user-only filesystem access. Paths are shared with CLI/FUSE via remotes.json;
key contents never enter JavaScript or remote configuration.

Desktop uses native WebKitGTK/WKWebView/WebView2 authentication handlers for the
embedded web app and protected browser windows. Certificate selection is limited
to configured HTTPS host/port pairs; unrelated certificate requests are cancelled.
Canvas password/token authentication and normal server verification remain enabled.

Windows requires explicit consent to import a missing identity into CurrentUser/My.
Existing matching identities with private keys are reused. The server picker shows
tracked imports and provides removal controls. First clear the identity from all
saved remotes and reconnect Desktop; only app-owned, unreferenced imports and keys
can be removed. Imported identities can also be used by other Windows applications.
macOS uses an application-owned session keychain, removed on orderly process exit.
Linux uses PEM credentials directly.

After renewing files or changing identity settings, use **Save and reconnect** in
the server picker. This restarts Desktop to clear native TLS sessions; restart
mounts/daemon mirrors separately. Certificate mounts require canvas-fuse 0.10.0+.

For native validation, build `cargo build --manifest-path src-tauri/Cargo.toml
--features tls-smoke-test --example tls-smoke`, then run
`node scripts/check-tls-native.mjs` from canvas-desktop. It requires sibling
canvas-common, nginx/OpenSSL, and Linux Xvfb/dbus-run-session. The test-only build
pins its private fixture server certificate/CA; production builds have no test
trust override. Windows tests require an ephemeral CI account and clean up their
fixture CA/imports. Platform runtime validation must pass before claiming support.

### Tiling and reusable windows

Desktop uses the web UI's navigation menus, document lists, editors and tool panels.
Preferences offers automatic tiling beside the menu or manual window placement.
The toolbox selects columns, grid or focus order and the gap; tiling preserves
frame order and respects the menu's actual position on its monitor.

Pin a canvas with the pin button in its tab bar to reuse that window across tree
navigation. Its tabs, selected view, document layout and monitor placement stay
with it while the selected data path changes. Pinned windows remain visible in
focus mode and tiling arranges other windows around them. Unpin to return the
window to the current path's layout.

The shell uses a new v2 local layout namespace. Existing v1 arrangements are not
loaded or migrated; server content and saved web views are unaffected.

### Browser controls and Terminal

The tab strip supports **+**, double-click on empty strip space, **Ctrl+T**
(new tab), **Ctrl+N** (new canvas), **Ctrl+W** (close tab), **Ctrl+Shift+T**
(reopen), **Ctrl+Tab / Ctrl+Shift+Tab**, **Ctrl+PageUp / PageDown**, and
**Ctrl+1…9**. Website tabs also support **Ctrl+L**, **Ctrl+R / F5** and
**Alt+Left / Right**. Middle-click closes a tab. Drag tabs to reorder or merge
windows, drag outside the window to detach, or use the detach button. Dragging
a lone tab moves its native window. Page identity belongs to the tab, so moving
it reparents the live webview with its history, form state and scripts intact.
Linux captures accelerators in GTK so they work while website webviews have focus.

**Terminal** is available in Apps, the content-view app picker, and the desktop
canvas launcher. Each workspace/tree/path has an independent set of local shell
sessions. Switching paths or closing a terminal canvas leaves those sessions
running; returning reattaches them with the same working directories, environment
and output. The session close button ends that shell and its jobs. Signing out
of the desktop shell or exiting the application ends its local sessions. Application
restart starts a new session manager; processes are not restored across restart.

The terminal uses xterm.js with a Rust portable-pty backend. It starts in your home
directory by default, or in the starting directory entered for the first session;
logical Canvas paths are not interpreted as filesystem paths. Session output is
bounded to 4 MiB per shell, and the manager accepts up to 128 sessions. Ctrl+C
interrupts the shell; Ctrl+Shift+C copies a selection. Website webviews cannot
invoke terminal commands. The UI app is shared with canvas-web through a terminal
transport provider; this build supplies the local Tauri transport.
