import { newCanvas, type Canvas, type CanvasKind, type Binding } from '../desktop-state.ts';

export type Scope = Extract<Binding, { mode: 'explorer' }>;
export type Frame = { id: string; tabs: Canvas[]; active: string };
export type Layout = { frames: Frame[]; focused: string; arrangement: 'columns' | 'grid' | 'focus' };
export type DesktopState = {
  version: 1;
  scope?: Scope;
  layouts: Record<string, Layout>;
  menu: 'hidden' | 'm2' | 'm1' | 'm0';
  placement: 'left' | 'top';
  gap: number;
  toolbox: { open: boolean; mode: 'context' | 'global'; page: 'tools' | 'agents' };
};
export const initialState = (): DesktopState => ({ version: 1, layouts: {}, menu: 'm1', placement: 'left', gap: 16, toolbox: { open: false, mode: 'context', page: 'tools' } });
export const normalizePath = (path: string) => '/' + path.split('/').filter(Boolean).join('/');
export const scopeKey = (scope: Scope) => JSON.stringify([scope.workspace, scope.tree, scope.treeType, normalizePath(scope.path)]);
export const scopeUrl = (scope: Scope) => `${scope.workspace}://${normalizePath(scope.path).slice(1)}`;
export function createFrame(kind: CanvasKind = 'content'): Frame {
  const canvas = newCanvas(kind);
  return { id: crypto.randomUUID(), tabs: [canvas], active: canvas.id };
}
export function navigate(state: DesktopState, scope: Scope): DesktopState {
  scope = { ...scope, path: normalizePath(scope.path) };
  const key = scopeKey(scope);
  if (state.layouts[key]) return { ...state, scope, menu: 'm2' };
  const frame = createFrame();
  return { ...state, scope, menu: 'm2', layouts: { ...state.layouts, [key]: { frames: [frame], focused: frame.id, arrangement: 'columns' } } };
}
export function updateLayout(state: DesktopState, key: string, update: (layout: Layout) => Layout): DesktopState {
  if (!state.layouts[key]) return state;
  return { ...state, layouts: { ...state.layouts, [key]: update(state.layouts[key]) } };
}
export function addCanvas(layout: Layout, kind: CanvasKind, asTab = false): Layout {
  const focused = layout.frames.find(frame => frame.id === layout.focused);
  if (asTab && focused) {
    const canvas = newCanvas(kind);
    return { ...layout, frames: layout.frames.map(frame => frame.id === focused.id ? { ...frame, tabs: [...frame.tabs, canvas], active: canvas.id } : frame) };
  }
  const frame = createFrame(kind);
  return { ...layout, focused: frame.id, frames: [...layout.frames, frame] };
}
/// A web page as a canvas tab. Empty url shows the address form.
export function browserCanvas(url = '', title?: string): Canvas {
  let name = title || '';
  if (!name && url) { try { name = new URL(url).host.replace(/^www\./, '') || url; } catch { name = url; } }
  return { ...newCanvas('browser'), url, title: name || 'New tab' };
}
/// Open a canvas from inside a frame: as a tab of that frame (the default),
/// or to the side as a new frame right after it (shift+click).
export function openTab(layout: Layout, canvas: Canvas, options: { frame?: string; side?: boolean } = {}): Layout {
  const sourceId = options.frame && layout.frames.some(frame => frame.id === options.frame) ? options.frame : layout.focused;
  const index = layout.frames.findIndex(frame => frame.id === sourceId);
  if (options.side || index < 0) {
    const frame: Frame = { id: crypto.randomUUID(), tabs: [canvas], active: canvas.id };
    const frames = [...layout.frames];
    frames.splice(index < 0 ? frames.length : index + 1, 0, frame);
    return { ...layout, frames, focused: frame.id };
  }
  return { ...layout, focused: sourceId, frames: layout.frames.map(frame => frame.id === sourceId ? { ...frame, tabs: [...frame.tabs, canvas], active: canvas.id } : frame) };
}
export function patchTab(layout: Layout, frameId: string, tabId: string, patch: Partial<Canvas>): Layout {
  return { ...layout, frames: layout.frames.map(frame => frame.id === frameId ? { ...frame, tabs: frame.tabs.map(tab => tab.id === tabId ? { ...tab, ...patch } : tab) } : frame) };
}
export function closeTab(layout: Layout, frameId: string, tabId: string): Layout {
  const frames = layout.frames.map(frame => {
    if (frame.id !== frameId) return frame;
    const tabs = frame.tabs.filter(tab => tab.id !== tabId);
    return { ...frame, tabs, active: frame.active === tabId ? tabs[0]?.id || '' : frame.active };
  }).filter(frame => frame.tabs.length);
  return { ...layout, frames, focused: frames.some(frame => frame.id === layout.focused) ? layout.focused : frames[0]?.id || '' };
}
export function detachTab(layout: Layout, frameId: string, tabId: string): Layout {
  const from = layout.frames.find(frame => frame.id === frameId);
  const tab = from?.tabs.find(tab => tab.id === tabId);
  if (!tab || from!.tabs.length < 2) return layout;
  const next = closeTab(layout, frameId, tabId);
  const frame = { id: crypto.randomUUID(), tabs: [tab], active: tab.id };
  return { ...next, focused: frame.id, frames: [...next.frames, frame] };
}
export function cycleMenu(menu: DesktopState['menu']): DesktopState['menu'] {
  return ({ hidden: 'm2', m2: 'm1', m1: 'm0', m0: 'hidden' } as const)[menu];
}
export function parseState(raw: string | null): DesktopState {
  if (!raw) return initialState();
  const value = JSON.parse(raw) as DesktopState;
  if (value.version !== 1 || !value.layouts || typeof value.layouts !== 'object' || Array.isArray(value.layouts)) throw new Error('Unsupported desktop layout version. Your saved layout has been left untouched.');
  if (!['hidden', 'm2', 'm1', 'm0'].includes(value.menu) || !['left', 'top'].includes(value.placement) || ![8, 16, 24].includes(value.gap)
    || !value.toolbox || typeof value.toolbox.open !== 'boolean' || !['context', 'global'].includes(value.toolbox.mode) || !['tools', 'agents'].includes(value.toolbox.page)) throw new Error('Invalid desktop preferences. Your saved layout has been left untouched.');
  if (value.scope && (value.scope.mode !== 'explorer' || !['workspace', 'tree', 'treeType', 'path'].every(key => typeof value.scope![key as keyof Scope] === 'string'))) throw new Error('Invalid saved location.');
  for (const layout of Object.values(value.layouts)) {
    if (!layout || !Array.isArray(layout.frames) || !['columns', 'grid', 'focus'].includes(layout.arrangement)) throw new Error('Invalid saved canvas layout.');
    const ids = new Set<string>();
    for (const frame of layout.frames) {
      if (!frame || typeof frame.id !== 'string' || ids.has(frame.id) || !Array.isArray(frame.tabs) || !frame.tabs.length) throw new Error('Invalid saved canvas window.');
      ids.add(frame.id);
      const tabIds = new Set<string>();
      for (const tab of frame.tabs) {
        if (!tab || typeof tab.id !== 'string' || tabIds.has(tab.id) || typeof tab.title !== 'string' || !['content', 'emails', 'messages', 'notes', 'files', 'tabs', 'browser'].includes(tab.kind)) throw new Error('Invalid saved canvas tab.');
        tabIds.add(tab.id);
      }
      if (!tabIds.has(frame.active)) throw new Error('Invalid active canvas tab.');
    }
    if (layout.frames.length && !ids.has(layout.focused)) throw new Error('Invalid focused canvas window.');
  }
  return value;
}
