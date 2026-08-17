// Feeds the tray's "Mounts" submenu (see src-tauri/src/fuse.rs). The Rust
// side spawns one detached canvas-fuse process per mount; the webview only
// supplies what to offer — it owns the API client, and workspaces aren't
// listable through the canvas-fuse CLI.
import { invoke } from '@tauri-apps/api/core'
import { listContexts, listWorkspaces } from './api'
import { contextUrlToPath } from './context-url'

export interface Mountable {
  kind: 'context' | 'workspace'
  /** workspace name, or `<workspace>/<context-id>` (canvas-fuse addresses contexts inside their workspace) */
  id: string
  label: string
}

/** Resolved path of the canvas-fuse binary, or null when not installed. */
export function fuseAvailable(): Promise<string | null> {
  return invoke<string | null>('fuse_available')
}

/** Fetch contexts + workspaces and push them to the tray menu. */
export async function syncMountables(serverUrl: string, token: string): Promise<void> {
  if (!(await fuseAvailable())) return
  const [contexts, workspaces] = await Promise.all([
    listContexts(serverUrl, token),
    listWorkspaces(serverUrl, token).catch(() => []),
  ])
  const items: Mountable[] = [
    ...contexts.map((c) => ({
      kind: 'context' as const,
      id: c.workspaceName ? `${c.workspaceName}/${c.id}` : c.id,
      label: `${c.id}: ${contextUrlToPath(c.url || '', c.workspaceName)}`,
    })),
    ...workspaces
      .filter((w) => w.name)
      .map((w) => ({ kind: 'workspace' as const, id: w.name, label: w.label || w.name })),
  ]
  await invoke('set_mountables', { items })
}
