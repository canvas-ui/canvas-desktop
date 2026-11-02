import { newCanvas, type Canvas, type CanvasKind } from '../desktop-state.ts';
import { addCanvas, browserCanvas, closeSavedTab, cycleMenu, detachTab, focusFrame, moveTab, navigate, navigateLocation, openTab, patchTab, scopeKey, tabAction, updateLayout, type DesktopState, type Frame, type Layout, type Scope, type TabAction } from './model.ts';

export type DesktopAction =
  | { type: 'navigate'; scope: Scope; location?: string; frame?: string; tab?: string }
  | { type: 'preferences'; patch: Partial<Pick<DesktopState, 'menu' | 'placement' | 'gap' | 'autoTile'>> }
  | { type: 'toolbox'; patch: Partial<DesktopState['toolbox']> }
  | { type: 'menu'; mode: 'cycle' | 'toggle' | 'show' }
  | { type: 'toggle-toolbox' | 'dismiss' }
  | { type: 'shortcut'; action: TabAction; frame?: string }
  | { type: 'focus-frame'; frame: string }
  | { type: 'open-canvas'; key?: string; kind: CanvasKind; asTab?: boolean }
  | { type: 'open-tab'; key?: string; canvas: Canvas; frame?: string; side?: boolean }
  | { type: 'activate-tab' | 'close-tab' | 'detach-tab'; key: string; frame: string; tab: string }
  | { type: 'patch-tab'; key: string; frame: string; tab: string; patch: Partial<Canvas> }
  | { type: 'close-frame'; key: string; frame: string }
  | { type: 'pin-frame'; key: string; frame: string; pinned?: boolean }
  | { type: 'move-tab'; key: string; source: string; tab: string; target: string; before?: string }
  | { type: 'arrangement'; key: string; arrangement: Layout['arrangement'] };
export type DesktopCommand = { id: string; action: DesktopAction; frame: Frame };
export function desktopCommand(action: DesktopAction): DesktopCommand {
  const canvas = action.type === 'open-canvas' ? newCanvas(action.kind) : action.type === 'shortcut' && ['new-tab', 'new-window'].includes(action.action) ? browserCanvas() : newCanvas('content');
  return { id: crypto.randomUUID(), action, frame: { id: crypto.randomUUID(), tabs: [canvas], active: canvas.id } };
}
/** Replay the same command optimistically and in the single authoritative host. */
export function desktopAction(state: DesktopState, { action, frame: initialFrame }: DesktopCommand): DesktopState {
  const scopeCanvas = { ...initialFrame.tabs[0], id: initialFrame.tabs[0].id + ':scope', kind: 'content' as const, title: 'Canvas', url: undefined };
  const scopeFrame = { id: initialFrame.id + ':scope', tabs: [scopeCanvas], active: scopeCanvas.id };
  if (action.type === 'navigate') return action.location ? navigateLocation(state, action.scope, action.location, action.frame, action.tab, initialFrame) : navigate(state, action.scope, initialFrame);
  if (action.type === 'preferences') return Object.entries(action.patch).every(([key, value]) => state[key as keyof DesktopState] === value) ? state : { ...state, ...action.patch };
  if (action.type === 'toolbox') return Object.entries(action.patch).every(([key, value]) => state.toolbox[key as keyof DesktopState['toolbox']] === value) ? state : { ...state, toolbox: { ...state.toolbox, ...action.patch } };
  if (action.type === 'toggle-toolbox') return { ...state, toolbox: { ...state.toolbox, open: !state.toolbox.open } };
  if (action.type === 'dismiss') return { ...state, menu: 'hidden', toolbox: { ...state.toolbox, open: false } };
  if (action.type === 'menu') return { ...state, menu: action.mode === 'cycle' ? cycleMenu(state.menu) : action.mode === 'toggle' && state.menu !== 'hidden' ? 'hidden' : state.scope ? 'm2' : 'm1' };
  if (action.type === 'shortcut') return tabAction(state, action.action, action.frame, initialFrame, scopeFrame);
  if (action.type === 'focus-frame') return focusFrame(state, action.frame);
  if (action.type === 'open-tab' && !state.scope) state = navigate(state, { mode: 'explorer', workspace: '', tree: 'context', treeType: 'context', path: '/' }, scopeFrame);
  const key = 'key' in action && action.key || (state.scope ? scopeKey(state.scope) : '');
  if (action.type === 'close-tab') return closeSavedTab(state, key, action.frame, action.tab);
  return updateLayout(state, key, layout => {
    if (action.type === 'open-canvas') return addCanvas(layout, action.kind, action.asTab, initialFrame);
    if (action.type === 'open-tab') return openTab(layout, action.canvas, { frame: action.frame, side: action.side, id: initialFrame.id });
    if (action.type === 'patch-tab') return patchTab(layout, action.frame, action.tab, action.patch);
    if (action.type === 'detach-tab') return detachTab(layout, action.frame, action.tab, initialFrame.id);
    if (action.type === 'arrangement') return layout.arrangement === action.arrangement ? layout : { ...layout, arrangement: action.arrangement };
    if (action.type === 'close-frame') {
      const frames = layout.frames.filter(frame => frame.id !== action.frame);
      return { ...layout, frames, focused: frames.some(frame => frame.id === layout.focused) ? layout.focused : frames[0]?.id || '' };
    }
    if (action.type === 'activate-tab') {
      const target = layout.frames.find(frame => frame.id === action.frame);
      if (!target || !target.tabs.some(tab => tab.id === action.tab) || target.active === action.tab) return layout;
      return { ...layout, focused: target.id, frames: layout.frames.map(frame => frame.id === target.id ? { ...frame, active: action.tab } : frame) };
    }
    if (action.type === 'pin-frame') return { ...layout, frames: layout.frames.map(frame => frame.id === action.frame ? { ...frame, pinned: action.pinned ?? !frame.pinned } : frame) };
    if (action.type === 'move-tab') return moveTab(layout, action.source, action.tab, action.target, action.before);
    throw new Error('Unsupported desktop action');
  });
}
