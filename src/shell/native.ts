import { invoke, isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { scopeKey, type DesktopState } from './model';

export const native = isTauri();
export const surface = new URLSearchParams(location.search).get('surface') || 'desktop';
// The host webview shares its label with its window; page webviews hang below it.
export const windowLabel = native ? getCurrentWindow().label : '';
let pending = Promise.resolve();
let revision = 0;
export function syncWindows(state: DesktopState, namespace: string) {
  if (!native || surface !== 'desktop') return Promise.resolve();
  const current = ++revision;
  const key = state.scope ? scopeKey(state.scope) : '';
  const layout = state.layouts[key];
  const request = { namespace, scope: key, frames: layout?.frames.map(frame => ({ id: frame.id, title: frame.tabs.find(tab => tab.id === frame.active)?.title || 'Canvas' })) || [], focused: layout?.focused || '', arrangement: layout?.arrangement || 'columns', gap: state.gap, placement: state.placement, menu: state.menu, toolboxOpen: state.toolbox.open };
  const result = pending.catch(() => {}).then(async () => { if (current === revision) await invoke('desktop_sync', { request }); });
  pending = result;
  return result;
}
export const tileWindows = () => native ? invoke('desktop_tile') : Promise.resolve();
export const stopWindows = () => native ? invoke('desktop_hide_surfaces') : Promise.resolve();

// Web pages inside a canvas: one native page webview per URL tab.
const page = (command: string, args: Record<string, unknown>) => native ? invoke(command, args) : Promise.resolve();
export const pageOpen = (window: string, tab: string, url: string, chrome: number) => page('desktop_url_open', { window, tab, url, chrome });
export const pageShow = (window: string, tab: string, chrome: number) => page('desktop_url_show', { window, tab, chrome });
export const pageHide = (window: string, tab: string) => page('desktop_url_hide', { window, tab });
export const pageClose = (window: string, tab: string) => page('desktop_url_close', { window, tab });
export const pageNavigate = (window: string, tab: string, url: string) => page('desktop_url_navigate', { window, tab, url });
export const pageAction = (window: string, tab: string, action: 'back' | 'forward' | 'reload' | 'stop') => page('desktop_url_action', { window, tab, action });
