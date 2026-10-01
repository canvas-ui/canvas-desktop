# Canvas Desktop

Workspace setup and tray mount manager scaffold. Requires `canvas-fuse` 0.9.1+
and `pm2` on PATH, a running Canvas server, and Linux FUSE support. PM2 and FUSE
are external prerequisites; the desktop bundle does not install them.

## Run

From `canvas/apps/desktop`:

```sh
npm run tauri dev
```

Sign in with email/password or an API token, naming the remote `user@remote-name`
to match the CLI. Existing CLI remotes appear in the
remote selector. Add multiple named remotes, select exports for each workspace,
choose one absolute workspaces root, and save the plan. Start/stop/restart exports
in the window or tray. Closing the window hides it; quitting the tray leaves
mount processes running. The tray is available again on the next desktop launch.

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
npm run build
cd src-tauri
cargo test --lib
```

The screen is a functional setup harness; polished wizard navigation, packaging
FUSE/PM2, OS startup integration and broader platform validation come later.
