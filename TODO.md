# TODO

## Resumable uploads

Desktop uploads should survive dropped connections and app restarts the way
the web's do. canvas-server (dev, 2026-10-24) serves resumable sessions on the
workspace API (`POST/PATCH/GET/DELETE /rest/v2/workspaces/:id/uploads`); the
protocol is described in `canvas-cli/TODO.md` and implemented for the browser
in `canvas-web/src/services/blobs.ts` (`uploadResumable`).

- [ ] Use the shared `canvas-common/packages/api-client` upload methods once
      they exist (tracked in canvas-cli/TODO.md) rather than a desktop copy.
- [ ] Files from ~8 MB go through sessions, identified by
      `<path>:<size>:<mtimeMs>`; no client-side hashing of large files.
- [ ] Unfinished uploads resume after an app restart (same fingerprint
      reopens the session; sessions live 7 days on the server by default).
- [ ] Uploads to Home or a mounted folder use `target: { type: 'object', ... }`
      so the bytes land on that backend directly.
