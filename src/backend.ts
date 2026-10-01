import { invoke } from '@tauri-apps/api/core';
import { CanvasApiClient } from '@augmentd-labs/canvas-api-client';
export type Remote = { url: string; apiBase?: string; auth?: { token?: string }; device?: { token?: string } };
export type Mount = { remote: string; workspace: string; export: 'home' | 'tree' | 'contexts'; tree: string | null; mode: 'mount' | 'mirror' };
export type Config = { version: number; workspaceRoot: string; mounts: Mount[] };
export type Setup = { config: Config; remotes: Record<string, Remote> };
export type Workspace = { name: string; label?: string };
export type Tree = { name: string; type: string; label?: string };
export type Status = { fuseAvailable: boolean; pm2Available: boolean; mounts: { path: string; process: string | null; fuse: { mounted: boolean; status?: string } | null }[] };
export const load = () => invoke<Setup>('load_setup');
export const save = (config: Config) => invoke('save_setup', { config });
export const status = () => invoke<Status>('mount_status');
export const action = (index: number, operation: string) => invoke('mount_action', { index, operation });
export const api = (remote: Remote) => new CanvasApiClient({ baseUrl: remote.url, apiBase: remote.apiBase, token: remote.auth?.token || remote.device?.token, appName: 'canvas-desktop' });
export async function login(id: string, url: string, email: string, password: string, token: string) {
  if (!/^[^@/\\]+@[^@/\\]+$/.test(id)) throw new Error('Remote name must be user@remote-name');
  const client = api({ url, auth: { token } });
  if (!token) {
    const result = await client.auth.login({ email, password });
    if (!result?.token) throw new Error('Login response has no token');
    token = result.token;
  }
  await api({ url, auth: { token } }).auth.me();
  await invoke('save_remote', { id, url, token });
}
