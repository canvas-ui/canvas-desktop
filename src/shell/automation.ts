import { browserCanvas, scopeKey, type Scope } from './model';
import type { DesktopStore } from './store';
import { kinds, type CanvasKind } from '../desktop-state';

// Small transport-independent UI contract. A future MCP transport can use this
// exact action surface; no tokens or document bodies are exposed by snapshots.
type DesktopAction =
  | { type: 'navigate'; scope: Scope }
  | { type: 'open-canvas'; kind: CanvasKind; asTab?: boolean }
  | { type: 'open-url'; url: string; side?: boolean }
  | { type: 'close-tab'; frame: string; tab: string }
  | { type: 'detach-tab'; frame: string; tab: string }
  | { type: 'activate-tab'; frame: string; tab: string }
  | { type: 'show-toolbox'; mode: 'context' | 'global' }
  | { type: 'show-menu' }
  | { type: 'set-tiling'; automatic: boolean }
  | { type: 'pin-frame'; frame: string; pinned: boolean };
export function installAutomation(store: DesktopStore) {
  window.__CANVAS_DESKTOP_UI__ = {
    version: 1,
    snapshot: () => structuredClone(store.get()),
    dispatch: (action: DesktopAction) => {
      if (action.type === 'navigate') {
        if (action.scope?.mode !== 'explorer' || !['workspace', 'tree', 'treeType', 'path'].every(key => typeof action.scope[key as keyof Scope] === 'string')) throw new Error('Invalid navigation scope.');
        store.dispatch(action); return;
      }
      if (action.type === 'set-tiling') { if (typeof action.automatic !== 'boolean') throw new Error('Invalid tiling mode.'); store.dispatch({ type: 'preferences', patch: { autoTile: action.automatic } }); return; }
      if (action.type === 'show-menu') { store.dispatch({ type: 'menu', mode: 'show' }); return; }
      if (action.type === 'show-toolbox') {
        if (!['context', 'global'].includes(action.mode)) throw new Error('Invalid toolbox mode.');
        store.dispatch({ type: 'toolbox', patch: { open: true, mode: action.mode } }); return;
      }
      const scope = store.get().scope;
      if (!scope) throw new Error('Choose a path first.');
      const key = scopeKey(scope);
      if (action.type === 'pin-frame') { if (typeof action.pinned !== 'boolean') throw new Error('Invalid pin.'); store.dispatch({ ...action, key }); return; }
      if (action.type === 'open-canvas' && kinds.includes(action.kind)) { store.dispatch({ ...action, key }); return; }
      if (action.type === 'activate-tab' || action.type === 'detach-tab' || action.type === 'close-tab') { store.dispatch({ ...action, key }); return; }
      if (action.type === 'open-url') {
        if (typeof action.url !== 'string' || !/^https?:\/\//i.test(action.url)) throw new Error('Open-url needs an http(s) address.');
        store.dispatch({ type: 'open-tab', key, canvas: browserCanvas(action.url), side: action.side }); return;
      }
      throw new Error('Unsupported desktop action.');
    },
  };
  return () => { delete window.__CANVAS_DESKTOP_UI__; };
}
