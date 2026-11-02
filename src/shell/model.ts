import { newCanvas, type Canvas, type CanvasKind, pathRoute } from '../desktop-state.ts';

export type Scope = { mode: 'explorer'; workspace: string; tree: string; treeType: string; path: string };
export type Frame = { id: string; tabs: Canvas[]; active: string; pinned?: boolean };
export type Layout = { frames: Frame[]; focused: string; arrangement: 'columns' | 'grid' | 'focus' };
export type DesktopState = {
  version: 2;
  scope?: Scope;
  layouts: Record<string, Layout>;
  menu: 'hidden' | 'm2' | 'm1' | 'm0';
  placement: 'left' | 'top';
  gap: number;
  autoTile: boolean;
  closedTabs?: { key: string; frame: string; tab: Canvas; index: number }[];
  toolbox: { open: boolean; mode: 'context' | 'global'; page: 'tools' | 'agents' };
};
export const initialState = (): DesktopState => ({ version: 2, layouts: {}, menu: 'm1', placement: 'left', gap: 16, autoTile: true, toolbox: { open: false, mode: 'context', page: 'tools' } });
const normalizePath = (path: string) => '/' + path.split('/').filter(Boolean).join('/');
export const scopeKey = (scope: Scope) => JSON.stringify([scope.workspace, scope.tree, scope.treeType, normalizePath(scope.path)]);
export const scopeUrl = (scope: Scope) => `${scope.workspace}://${normalizePath(scope.path).slice(1)}`;
function createFrame(kind: CanvasKind = 'content'): Frame {
  const canvas = newCanvas(kind);
  return { id: crypto.randomUUID(), tabs: [canvas], active: canvas.id };
}
export function navigate(state: DesktopState, scope: Scope, initialFrame?: Frame): DesktopState {
  scope = { ...scope, path: normalizePath(scope.path) };
  const key = scopeKey(scope);
  const previousKey = state.scope ? scopeKey(state.scope) : '';
  if (key === previousKey) return { ...state, scope, menu: 'm2' };
  const previous = state.layouts[previousKey];
  const pinned = previous?.frames.filter(frame => frame.pinned).map(frame => ({ ...frame, tabs: frame.tabs.map(tab => {
    if (tab.kind !== 'web' || !tab.location || !routeScope(tab.location, () => scope.treeType)) return tab;
    const suffix = tab.location.match(/[?#].*$/)?.[0] || '';
    return { ...tab, location: pathRoute(scope.workspace, scope.tree, scope.path) + suffix };
  }) })) || [];
  const layouts = { ...state.layouts };
  if (pinned.length && previous) {
    const frames = previous.frames.filter(frame => !frame.pinned);
    layouts[previousKey] = { ...previous, frames, focused: frames.some(frame => frame.id === previous.focused) ? previous.focused : frames[0]?.id || '' };
  }
  const target = layouts[key];
  const frames = [...pinned, ...(target?.frames || [])];
  if (!target && !frames.length) frames.push(initialFrame || createFrame());
  layouts[key] = { frames, focused: pinned.find(frame => frame.id === previous?.focused)?.id || target?.focused || frames[0]?.id || '', arrangement: target?.arrangement || previous?.arrangement || 'columns' };
  return { ...state, scope, menu: 'm2', layouts };
}
/** Navigate the tree while preserving page query/hash state in the destination tab. */
export function navigateLocation(state: DesktopState, scope: Scope, location: string, frameId?: string, tabId?: string, initialFrame?: Frame): DesktopState {
  const next = navigate(state, scope, initialFrame);
  return updateLayout(next, scopeKey(scope), layout => {
    const frame = layout.frames.find(frame => frame.id === frameId) || layout.frames.find(frame => frame.id === layout.focused);
    if (!frame) return layout;
    const tab = frame.tabs.find(tab => tab.id === tabId) || frame.tabs.find(tab => tab.id === frame.active)!;
    return patchTab(layout, frame.id, tab.id, { location });
  });
}
export function updateLayout(state: DesktopState, key: string, update: (layout: Layout) => Layout): DesktopState {
  if (!state.layouts[key]) return state;
  const layout = update(state.layouts[key]);
  return layout === state.layouts[key] ? state : { ...state, layouts: { ...state.layouts, [key]: layout } };
}
/** Native focus notifications can outlive a closed or hidden frame. */
export function focusFrame(state: DesktopState, frameId: string): DesktopState {
  if (!state.scope) return state;
  const key = scopeKey(state.scope);
  const layout = state.layouts[key];
  if (!layout || layout.focused === frameId || !layout.frames.some(frame => frame.id === frameId)) return state;
  return updateLayout(state, key, layout => ({ ...layout, focused: frameId }));
}
export function addCanvas(layout: Layout, kind: CanvasKind, asTab = false, initialFrame?: Frame): Layout {
  const focused = layout.frames.find(frame => frame.id === layout.focused);
  if (asTab && focused) {
    const canvas = initialFrame?.tabs[0] || newCanvas(kind);
    return { ...layout, frames: layout.frames.map(frame => frame.id === focused.id ? { ...frame, tabs: [...frame.tabs, canvas], active: canvas.id } : frame) };
  }
  const frame = initialFrame || createFrame(kind);
  return { ...layout, focused: frame.id, frames: [...layout.frames, frame] };
}
/// A web page as a canvas tab. Empty url shows the address form.
export function browserCanvas(url = '', title?: string): Canvas {
  let name = title || '';
  if (!name && url) { try { name = new URL(url).host.replace(/^www\./, '') || url; } catch { name = url; } }
  return { ...newCanvas('browser'), url, title: name || 'New tab' };
}
/// A web UI route as a canvas tab.
export function webCanvas(location: string, title = webTitle(location)): Canvas {
  return { ...newCanvas('web'), location, title };
}
/** A readable tab title for a web UI location. */
export function webTitle(location: string): string {
  const pathname = location.split(/[?#]/)[0];
  const segments = pathname.split('/').filter(Boolean).map(segment => { try { return decodeURIComponent(segment); } catch { return segment; } });
  if (!segments.length) return 'Desk';
  if (segments[0] === 'home') return 'Home';
  if (segments[0] === 'workspaces' && segments.length === 1) return 'Workspaces';
  if (segments[0] === 'workspaces' && segments.includes('documents')) return 'Document';
  if (segments[0] === 'workspaces') return segments[segments.length - 1] === 'path' || segments.length === 2 ? segments[1] : segments[segments.length - 1];
  return segments[segments.length - 1].replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());
}
/** The web UI route of a document, as the webui's document page expects it. */
export function documentLocation(workspaceId: string, documentId: string | number): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(String(documentId))}`;
}
/** A web UI route that is a workspace tree path, if it is one. */
export function routeScope(location: string, treeType: (tree: string) => string): Scope | undefined {
  const segments = location.split(/[?#]/)[0].split('/').filter(Boolean).map(segment => { try { return decodeURIComponent(segment); } catch { return segment; } });
  if (segments[0] !== 'workspaces' || !segments[1] || segments.includes('documents') || segments.includes('settings')) return undefined;
  const tree = segments[2] === 'trees' && segments[3] ? segments[3] : 'context';
  const pathStart = segments.indexOf('path');
  if (segments.length > 2 && segments[2] !== 'trees' && segments[2] !== 'path') return undefined;
  const path = pathStart >= 0 ? '/' + segments.slice(pathStart + 1).join('/') : '/';
  return { mode: 'explorer', workspace: segments[1], tree, treeType: treeType(tree), path: normalizePath(path) };
}
/// Open a canvas from inside a frame: as a tab of that frame (the default),
/// or to the side as a new frame right after it (shift+click).
export function openTab(layout: Layout, canvas: Canvas, options: { frame?: string; side?: boolean; id?: string } = {}): Layout {
  const sourceId = options.frame && layout.frames.some(frame => frame.id === options.frame) ? options.frame : layout.focused;
  const index = layout.frames.findIndex(frame => frame.id === sourceId);
  if (options.side || index < 0) {
    const frame: Frame = { id: options.id || crypto.randomUUID(), tabs: [canvas], active: canvas.id };
    const frames = [...layout.frames];
    frames.splice(index < 0 ? frames.length : index + 1, 0, frame);
    return { ...layout, frames, focused: frame.id };
  }
  return { ...layout, focused: sourceId, frames: layout.frames.map(frame => frame.id === sourceId ? { ...frame, tabs: [...frame.tabs, canvas], active: canvas.id } : frame) };
}
export function patchTab(layout: Layout, frameId: string, tabId: string, patch: Partial<Canvas>): Layout {
  const current = layout.frames.find(frame => frame.id === frameId)?.tabs.find(tab => tab.id === tabId);
  if (!current || Object.entries(patch).every(([key, value]) => current[key as keyof Canvas] === value)) return layout;
  return { ...layout, frames: layout.frames.map(frame => frame.id === frameId ? { ...frame, tabs: frame.tabs.map(tab => tab.id === tabId ? { ...tab, ...patch } : tab) } : frame) };
}
export function closeTab(layout: Layout, frameId: string, tabId: string): Layout {
  const frames = layout.frames.map(frame => {
    if (frame.id !== frameId) return frame;
    const tabs = frame.tabs.filter(tab => tab.id !== tabId);
    return { ...frame, tabs, active: frame.active === tabId ? tabs[Math.min(frame.tabs.findIndex(tab => tab.id === tabId), tabs.length - 1)]?.id || '' : frame.active };
  }).filter(frame => frame.tabs.length);
  return { ...layout, frames, focused: frames.some(frame => frame.id === layout.focused) ? layout.focused : frames[0]?.id || '' };
}
export function detachTab(layout: Layout, frameId: string, tabId: string, id: string = crypto.randomUUID()): Layout {
  const from = layout.frames.find(frame => frame.id === frameId);
  const tab = from?.tabs.find(tab => tab.id === tabId);
  if (!tab || from!.tabs.length < 2) return layout;
  const next = closeTab(layout, frameId, tabId);
  const frame = { id, tabs: [tab], active: tab.id };
  return { ...next, focused: frame.id, frames: [...next.frames, frame] };
}
export function cycleMenu(menu: DesktopState['menu']): DesktopState['menu'] {
  return ({ hidden: 'm2', m2: 'm1', m1: 'm0', m0: 'hidden' } as const)[menu];
}
export function parseState(raw: string | null): DesktopState {
  if (!raw) return initialState();
  return validateState(JSON.parse(raw));
}
export function validateState(value: DesktopState): DesktopState {
  if (value.version !== 2 || !value.layouts || typeof value.layouts !== 'object' || Array.isArray(value.layouts)) throw new Error('Unsupported desktop layout version. Your saved layout has been left untouched.');
  if (!['hidden', 'm2', 'm1', 'm0'].includes(value.menu) || !['left', 'top'].includes(value.placement) || ![8, 16, 24].includes(value.gap)
    || typeof value.autoTile !== 'boolean'
    || !value.toolbox || typeof value.toolbox.open !== 'boolean' || !['context', 'global'].includes(value.toolbox.mode) || !['tools', 'agents'].includes(value.toolbox.page)) throw new Error('Invalid desktop preferences. Your saved layout has been left untouched.');
  if (value.scope && (value.scope.mode !== 'explorer' || !['workspace', 'tree', 'treeType', 'path'].every(key => typeof value.scope![key as keyof Scope] === 'string'))) throw new Error('Invalid saved location.');
  if (value.closedTabs !== undefined && (!Array.isArray(value.closedTabs) || value.closedTabs.some(row => !row || typeof row.key !== 'string' || typeof row.frame !== 'string' || !row.tab || typeof row.tab.id !== 'string' || !Number.isInteger(row.index)))) throw new Error('Invalid recently closed tabs.');
  const ids = new Set<string>();
  for (const [key, layout] of Object.entries(value.layouts)) {
    if (!layout || !Array.isArray(layout.frames) || !['columns', 'grid', 'focus'].includes(layout.arrangement)) throw new Error('Invalid saved canvas layout.');
    for (const frame of layout.frames) {
      if (frame?.pinned !== undefined && typeof frame.pinned !== 'boolean') throw new Error('Invalid canvas pin.');
      if (!frame || typeof frame.id !== 'string' || ids.has(frame.id) || !Array.isArray(frame.tabs) || !frame.tabs.length) throw new Error('Invalid saved canvas window.');
      ids.add(frame.id);
      const tabIds = new Set<string>();
      for (const tab of frame.tabs) {
        if (!tab || typeof tab.id !== 'string' || tabIds.has(tab.id) || typeof tab.title !== 'string' || !['content', 'emails', 'messages', 'notes', 'files', 'tabs', 'browser', 'web', 'terminal'].includes(tab.kind)) throw new Error('Invalid saved canvas tab.');
        if (tab.documentLayout !== undefined && !['card', 'table', 'tile'].includes(tab.documentLayout)) throw new Error('Invalid document layout.');
        if (tab.view !== undefined && (!tab.view || typeof tab.view.id !== 'string' || typeof tab.view.name !== 'string' || !['documents', 'columns', 'app'].includes(tab.view.kind))) throw new Error('Invalid content view.');
        tabIds.add(tab.id);
      }
      if (!tabIds.has(frame.active)) throw new Error('Invalid active canvas tab.');
    }
    if (typeof layout.focused !== 'string') throw new Error('Invalid focused canvas window.');
    // Selection can outlive a native window; the frames and tabs remain authoritative.
    if (!layout.frames.some(frame => frame.id === layout.focused)) value = { ...value, layouts: { ...value.layouts, [key]: { ...layout, focused: layout.frames[0]?.id || '' } } };
  }
  return value;
}

export type TabAction = 'new-tab' | 'new-window' | 'close-tab' | 'next-tab' | 'previous-tab' | 'reopen-tab' | `select-${number}`;
export function tabAction(state: DesktopState, action: TabAction, frameId?: string, initialFrame?: Frame, initialScopeFrame?: Frame): DesktopState {
  const ready = state.scope ? state : navigate(state, { mode: 'explorer', workspace: '', tree: 'context', treeType: 'context', path: '/' }, initialScopeFrame);
  if (action === 'reopen-tab') {
    const closed = ready.closedTabs?.[ready.closedTabs.length - 1];
    if (!closed) return ready;
    const [workspace, tree, treeType, path] = JSON.parse(closed.key);
    const restored = navigate({ ...ready, closedTabs: ready.closedTabs!.slice(0, -1) }, { mode: 'explorer', workspace, tree, treeType, path }, initialFrame);
    return updateLayout(restored, closed.key, layout => {
      const frame = layout.frames.find(frame => frame.id === closed.frame);
      if (!frame) return { ...layout, frames: [...layout.frames, { id: closed.frame, tabs: [closed.tab], active: closed.tab.id }], focused: closed.frame };
      const tabs = [...frame.tabs]; tabs.splice(closed.index, 0, closed.tab);
      return { ...layout, focused: frame.id, frames: layout.frames.map(row => row.id === frame.id ? { ...row, tabs, active: closed.tab.id } : row) };
    });
  }
  const key = scopeKey(ready.scope!);
  if (frameId && !ready.layouts[key]?.frames.some(frame => frame.id === frameId)) return ready;
  if (action === 'close-tab') {
    const layout = ready.layouts[key];
    const frame = layout?.frames.find(frame => frame.id === frameId) || layout?.frames.find(frame => frame.id === layout.focused);
    return frame ? closeSavedTab(ready, key, frame.id, frame.active) : ready;
  }
  return updateLayout(ready, key, layout => {
    const frame = layout.frames.find(frame => frame.id === frameId) || layout.frames.find(frame => frame.id === layout.focused);
    if (action === 'new-tab' || action === 'new-window') return openTab(layout, initialFrame?.tabs[0] || browserCanvas(), { frame: frame?.id, side: action === 'new-window', id: initialFrame?.id });
    if (!frame) return layout;
    const index = frame.tabs.findIndex(tab => tab.id === frame.active);
    const next = action === 'next-tab' ? (index + 1) % frame.tabs.length : action === 'previous-tab' ? (index + frame.tabs.length - 1) % frame.tabs.length : action === 'select-9' ? frame.tabs.length - 1 : Number(action.slice(7)) - 1;
    if (!frame.tabs[next]) return layout;
    return { ...layout, focused: frame.id, frames: layout.frames.map(row => row.id === frame.id ? { ...row, active: frame.tabs[next].id } : row) };
  });
}
export function moveTab(layout: Layout, source: string, tabId: string, target: string, before?: string): Layout {
  const from = layout.frames.find(frame => frame.id === source);
  const to = layout.frames.find(frame => frame.id === target);
  const tab = from?.tabs.find(tab => tab.id === tabId);
  if (!tab || !to || before === tabId) return layout;
  const tabs = to.tabs.filter(row => row.id !== tabId);
  const index = tabs.findIndex(row => row.id === before);
  tabs.splice(index < 0 ? tabs.length : index, 0, tab);
  const frames = layout.frames.map(frame => frame.id === target ? { ...frame, tabs, active: tab.id } : frame.id === source ? { ...frame, tabs: frame.tabs.filter(row => row.id !== tabId), active: frame.active === tabId ? frame.tabs.find(row => row.id !== tabId)?.id || '' : frame.active } : frame).filter(frame => frame.tabs.length);
  return { ...layout, frames, focused: target };
}

export function closeSavedTab(state: DesktopState, key: string, frameId: string, tabId: string): DesktopState {
  const frame = state.layouts[key]?.frames.find(frame => frame.id === frameId);
  const index = frame?.tabs.findIndex(tab => tab.id === tabId) ?? -1;
  if (!frame || index < 0) return state;
  const next = updateLayout(state, key, layout => closeTab(layout, frameId, tabId));
  return { ...next, closedTabs: [...(state.closedTabs || []), { key, frame: frameId, tab: frame.tabs[index], index }].slice(-20) };
}
