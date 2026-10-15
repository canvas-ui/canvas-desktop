import { addCanvas, closeTab, navigate, scopeKey, updateLayout, type Scope } from './model';
import type { DesktopStore } from './store';
import { kinds, type CanvasKind } from '../desktop-state';

// Small transport-independent UI contract. A future MCP transport can use this
// exact action surface; no tokens or document bodies are exposed by snapshots.
export type DesktopAction =
  | { type: 'navigate'; scope: Scope }
  | { type: 'open-canvas'; kind: CanvasKind; asTab?: boolean }
  | { type: 'close-tab'; frame: string; tab: string }
  | { type: 'show-toolbox'; mode: 'context' | 'global' }
  | { type: 'show-menu' };
export function installAutomation(store: DesktopStore) {
  window.__CANVAS_DESKTOP_UI__ = {
    version: 1,
    snapshot: () => structuredClone(store.get()),
    dispatch: (action: DesktopAction) => store.update(state => {
      if (action.type === 'navigate') {
        if (action.scope?.mode !== 'explorer' || !['workspace', 'tree', 'treeType', 'path'].every(key => typeof action.scope[key as keyof Scope] === 'string')) throw new Error('Invalid navigation scope.');
        return navigate(state, action.scope);
      }
      if (action.type === 'show-menu') return { ...state, menu: state.scope ? 'm2' : 'm1' };
      if (action.type === 'show-toolbox') {
        if (!['context', 'global'].includes(action.mode)) throw new Error('Invalid toolbox mode.');
        return { ...state, toolbox: { ...state.toolbox, open: true, mode: action.mode } };
      }
      if (!state.scope) throw new Error('Choose a path first.');
      if (action.type === 'open-canvas' && kinds.includes(action.kind)) return updateLayout(state, scopeKey(state.scope), layout => addCanvas(layout, action.kind, action.asTab));
      if (action.type === 'close-tab') return updateLayout(state, scopeKey(state.scope), layout => closeTab(layout, action.frame, action.tab));
      throw new Error('Unsupported desktop action.');
    }),
  };
  return () => { delete window.__CANVAS_DESKTOP_UI__; };
}
