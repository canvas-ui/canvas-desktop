import { addCanvas, browserCanvas, closeSavedTab, detachTab, navigate, openTab, scopeKey, updateLayout, type Scope } from './model';
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
    dispatch: (action: DesktopAction) => store.update(state => {
      if (action.type === 'navigate') {
        if (action.scope?.mode !== 'explorer' || !['workspace', 'tree', 'treeType', 'path'].every(key => typeof action.scope[key as keyof Scope] === 'string')) throw new Error('Invalid navigation scope.');
        return navigate(state, action.scope);
      }
      if (action.type === 'set-tiling') { if (typeof action.automatic !== 'boolean') throw new Error('Invalid tiling mode.'); return { ...state, autoTile: action.automatic }; }
      if (action.type === 'show-menu') return { ...state, menu: state.scope ? 'm2' : 'm1' };
      if (action.type === 'show-toolbox') {
        if (!['context', 'global'].includes(action.mode)) throw new Error('Invalid toolbox mode.');
        return { ...state, toolbox: { ...state.toolbox, open: true, mode: action.mode } };
      }
      if (!state.scope) throw new Error('Choose a path first.');
      if (action.type === 'pin-frame') { if (typeof action.pinned !== 'boolean') throw new Error('Invalid pin.'); return updateLayout(state, scopeKey(state.scope), layout => ({ ...layout, frames: layout.frames.map(frame => frame.id === action.frame ? { ...frame, pinned: action.pinned } : frame) })); }
      if (action.type === 'open-canvas' && kinds.includes(action.kind)) return updateLayout(state, scopeKey(state.scope), layout => addCanvas(layout, action.kind, action.asTab));
      if (action.type === 'activate-tab') return updateLayout(state, scopeKey(state.scope), layout => ({ ...layout, focused: layout.frames.some(frame => frame.id === action.frame && frame.tabs.some(tab => tab.id === action.tab)) ? action.frame : layout.focused, frames: layout.frames.map(frame => frame.id === action.frame && frame.tabs.some(tab => tab.id === action.tab) ? { ...frame, active: action.tab } : frame) }));
      if (action.type === 'detach-tab') return updateLayout(state, scopeKey(state.scope), layout => detachTab(layout, action.frame, action.tab));
      if (action.type === 'close-tab') return closeSavedTab(state, scopeKey(state.scope), action.frame, action.tab);
      if (action.type === 'open-url') {
        if (typeof action.url !== 'string' || !/^https?:\/\//i.test(action.url)) throw new Error('Open-url needs an http(s) address.');
        return updateLayout(state, scopeKey(state.scope), layout => openTab(layout, browserCanvas(action.url), { side: !!action.side }));
      }
      throw new Error('Unsupported desktop action.');
    }),
  };
  return () => { delete window.__CANVAS_DESKTOP_UI__; };
}
