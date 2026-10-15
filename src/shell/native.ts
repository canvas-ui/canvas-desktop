import { invoke, isTauri } from '@tauri-apps/api/core';
import { scopeKey, type DesktopState } from './model';

export const native = isTauri();
export const surface = new URLSearchParams(location.search).get('surface') || 'desktop';
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
