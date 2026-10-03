# Canvas Desktop

Context-driven desktop with saved multi-canvas arrangements and a tray mount
manager. Browsing requires a running Canvas server. Mount management additionally
requires `canvas-fuse` 0.9.1+, `pm2` on PATH, and Linux FUSE support. PM2 and FUSE
are external prerequisites; the desktop bundle does not install them.

## Run

```sh
pnpm install
pnpm run tauri dev
```

Open **Mounts & connections** to sign in with email/password or an API token, naming the remote `user@remote-name`
to match the CLI. Existing CLI remotes appear in the
remote selector. Add multiple named remotes, select exports for each workspace,
choose one absolute workspaces root, and save the plan. Start/stop/restart exports
in the window or tray. Closing the window hides it; quitting the tray leaves
mount processes running. The tray is available again on the next desktop launch.

## Desktop navigation

- **Explorer** selects a workspace, a context/directory tree, and a path. The
  selected layer owns its arrangement under `metadata.ui.desktop`. A missing
  arrangement produces one Content canvas; a saved empty arrangement stays empty.
- **Contexts** selects an existing named context. Its own `metadata.ui.desktop`
  owns the arrangement. Use the POV address or the bound tree's path buttons to
  navigate. The context URL changes on the server, so other context-bound apps
  follow it. Existing stored filters remain server-enforced.

Add Content, Emails, Messages, Notes, Files, Tabs or Browser canvases. Reorder
with the arrow buttons; set title, column span, height, optional query or browser
address in Settings. **Save arrangement** persists changes on the current owner.
Explorer navigation prompts before discarding unsaved arrangement changes;
context POV navigation retains those edits. **Reload saved** restores the owner.
Use **Start workspace** if its tree cannot be loaded because it is stopped.

Each arrangement has `{ version: 1, canvases: [...] }`. Canvas IDs are stable and
runtime state is not persisted. Unsupported/malformed arrangements report an
error instead of replacing stored metadata. Saving re-reads metadata and merges
only `ui.desktop`, preserving sibling UI fields and toolbox metadata. The server
currently has no metadata revision precondition, so simultaneous metadata saves
can still race.

Document canvases provide paginated lists and text details, optional additional
queries, manual refresh and live Socket.IO refresh. Requests are cancelled when
views leave their scope; connection subscriptions are replaced on remote/scope
changes. Context document reads use the context endpoint so stored filters are
composed by the server. Explorer reads use the workspace path endpoint so ancestor
constraints apply.

Browser canvases currently open isolated native browser **windows**, with HTTP(S)
addresses only and no main-window capabilities or Canvas credentials. They are
not yet embedded in the grid, and their sessions are not restored/closed by tree
navigation. Full shared web editors, inline browser hosting and richer application
views remain follow-up work; this shell does not yet provide web feature parity.

## Shared configuration

Credentials live exclusively in `~/.canvas/config/remotes.json`, using the CLI's
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

Mount only provides a live read/write filesystem. Mirror is Home-only: FUSE
pins all files, retains an offline cache, uploads writes, and handles remote
removals through its mirror trash. This is a FUSE-backed mirror, not a separate
watcher syncing an ordinary folder. Trees and Contexts remain live mounts.
Git exports are deferred.

PM2 runs foreground FUSE processes, without `--detach`. It stores generated
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

Mount settings retain the existing setup harness. Packaging FUSE/PM2, OS startup
integration and broader platform validation come later.

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
