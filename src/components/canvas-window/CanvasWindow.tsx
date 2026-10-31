import { getCurrentWindow } from '@tauri-apps/api/window';
import { tabShortcut } from '../../shell/tab-shortcuts';
import { TerminalApplet } from '@web/components/toolbox/applets/TerminalApplet';
import { AppletTargetProvider } from '@web/components/toolbox/applets/applet-target';
import { lazy, Suspense, useEffect, useRef, useState, useMemo } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, File, FileText, Globe, Layers3, Mail, MessageSquare, PanelsTopLeft, Plus, RefreshCw, X, Columns2, ExternalLink, Square, Pin, TerminalSquare } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { pathRoute, type Canvas, type CanvasKind } from '../../desktop-state';
import { browserCanvas, closeSavedTab, detachTab, moveTab, focusFrame, navigateLocation, openTab, patchTab, routeScope, scopeKey, scopeUrl, updateLayout, webCanvas, webTitle, type Frame, type Layout } from '../../shell/model';
import type { DesktopServices } from '../../shell/integration';
import { native, windowLabel, pageAction, pageHide, pageOpen, pageShow } from '../../shell/native';
import { ResizeEdges, WindowControls, useWindowChrome } from '../../shell/chrome';
import './canvas-window.css';

const WebCanvas = lazy(() => import('./WebCanvas'));
export const canvasIcons = { content: Layers3, notes: FileText, emails: Mail, messages: MessageSquare, files: File, tabs: Globe, browser: Globe, web: PanelsTopLeft, terminal: TerminalSquare };
export const canvasNames: Record<CanvasKind, string> = { content: 'Canvas', notes: 'Notes', emails: 'Email', messages: 'Messages', files: 'Files', tabs: 'Saved tabs', browser: 'Web page', web: 'Web UI', terminal: 'Terminal' };
type PageEvent = { tab: string; url?: string; title?: string; loading?: boolean };
/** Addresses typed without a scheme are websites. */
function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}
// Page URLs reported by the native webview must not be navigated to again.
const observed = new Map<string, string>();

export function CanvasWindow({ frame, services }: { frame: Frame; services: DesktopServices }) {
  const { store, scope, layout, report } = services;
  const canvas = frame.tabs.find(tab => tab.id === frame.active)!;
  const [error, setError] = useState('');
  const [pageLoading, setPageLoading] = useState<Record<string, boolean>>({});
  const [chromeHeight, setChromeHeight] = useState(0);
  const chromeRef = useRef<HTMLDivElement>(null);
  const stripDrag = useRef<{ x: number; y: number } | undefined>(undefined);
  const chrome = useWindowChrome(report);
  const key = scope ? scopeKey(scope) : '';
  // Per-tab back stack for the web UI's own back buttons (not persisted).
  const history = useRef(new Map<string, string[]>());
  const webLocation = canvas.kind === 'web' ? canvas.location || '/home' : scope ? pathRoute(scope.workspace, scope.tree, scope.path) + (canvas.location?.match(/[?#].*$/)?.[0] || '') : '/';
  /** The web UI navigated inside this tab: tree paths switch the desktop context, anything else stays a web tab. */
  const webNavigate = (next: string, record = true) => {
    if (next === webLocation) return;
    if (record) history.current.set(canvas.id, [...(history.current.get(canvas.id) || []), webLocation].slice(-50));
    const target = scope && routeScope(next, tree => tree === scope.tree ? scope.treeType : tree === 'context' ? 'context' : 'directory');
    if (target && canvas.kind !== 'web') { try { store.update(old => navigateLocation(old, target, next, frame.id, canvas.id)); } catch (e) { report(e); } return; }
    change(old => patchTab(old, frame.id, canvas.id, { kind: 'web', location: next, title: webTitle(next) }));
  };
  const webBack = (delta: number) => {
    const stack = history.current.get(canvas.id) || [];
    const previous = stack[stack.length + Math.min(-1, delta)];
    if (previous === undefined) return;
    history.current.set(canvas.id, stack.slice(0, stack.length + Math.min(-1, delta)));
    webNavigate(previous, false);
  };
  const close = (tabId: string) => { try { store.update(old => closeSavedTab(old, key, frame.id, tabId)); } catch (error) { report(error); } };
  const change = (fn: (layout: Layout) => Layout) => {
    try { store.update(state => updateLayout(state, key, fn)); } catch (e) { report(e); }
  };
  const windowView = useMemo(() => ({
    pinned: !!frame.pinned, view: canvas.view, documentLayout: canvas.documentLayout,
    selectView: (view: NonNullable<Canvas['view']>) => { if (JSON.stringify(canvas.view) !== JSON.stringify(view)) change(old => patchTab(old, frame.id, canvas.id, { view })); },
    selectDocumentLayout: (documentLayout: Canvas['documentLayout']) => change(old => patchTab(old, frame.id, canvas.id, { documentLayout })),
  }), [frame.pinned, canvas.view, canvas.documentLayout, canvas.id, key]);
  /** Open a canvas from this frame: tab by default, to the side on shift. */
  const open = (next: Canvas, side: boolean) => {
    change(old => openTab(old, next, { frame: frame.id, side }));
    if (side) services.tile();
  };
  useEffect(() => {
    if (!native) return;
    // Page webviews report back to the host webview of their own window.
    const listeners = [listen<PageEvent>('desktop:url', ({ payload }) => {
      if (!frame.tabs.some(tab => tab.id === payload.tab)) return;
      if (payload.loading !== undefined) setPageLoading(old => ({ ...old, [payload.tab]: payload.loading! }));
      const patch: Partial<Canvas> = {};
      if (payload.url) { observed.set(payload.tab, payload.url); patch.url = payload.url; }
      if (payload.title?.trim()) patch.title = payload.title.trim();
      if (Object.keys(patch).length) change(old => patchTab(old, frame.id, payload.tab, patch));
    }), listen<{ tab: string; url: string }>('desktop:url-open', ({ payload }) => {
      if (frame.tabs.some(tab => tab.id === payload.tab)) open(browserCanvas(payload.url), false);
    })];
    return () => listeners.forEach(promise => { void promise.then(unlisten => unlisten()).catch(() => {}); });
  }, [frame.id, frame.tabs.map(tab => tab.id).join(), key]);
  useEffect(() => {
    const element = chromeRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setChromeHeight(element.offsetHeight));
    observer.observe(element);
    setChromeHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, []);
  async function browseExternally(url: string) {
    try {
      const parsed = new URL(normalizeAddress(url));
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use an HTTP or HTTPS address without credentials.');
      if (native) await invoke('open_browser', { url: parsed.href });
      else window.open(parsed.href, '_blank', 'noopener,noreferrer');
    } catch (e) { setError(String(e)); }
  }
  const focused = layout?.focused === frame.id;
  const browser = canvas.kind === 'browser';
  const terminal = canvas.kind === 'terminal';
  const web = !browser && !terminal;
  return <section className={`cw-window ${focused ? 'is-focused' : ''} ${browser ? 'is-browser' : ''} ${web || terminal ? 'is-web' : ''}`} aria-label={`${canvasNames[canvas.kind]} canvas`} onPointerDown={() => { if (!focused) { try { store.update(old => focusFrame(old, frame.id)); } catch (error) { report(error); } } }} onClickCapture={event => {
    // Web links open inside the canvas: a tab here, or beside it with shift.
    const link = (event.target as Element).closest('a[href]');
    const href = link?.getAttribute('href') || '';
    if (link && /^https?:\/\//i.test(href)) { event.preventDefault(); event.stopPropagation(); open(browserCanvas(href, link.textContent?.trim() || undefined), event.shiftKey); }
  }}>
    <ResizeEdges chrome={chrome} />
    <div className="cw-chrome" ref={chromeRef}>
      <header className="cw-titlebar" onPointerDown={chrome.drag}>
        <div className="cw-tabs" role="tablist" aria-label="Canvas tabs" onPointerDown={event => { if (event.target === event.currentTarget) { event.stopPropagation(); stripDrag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerUp={() => { stripDrag.current = undefined; }} onPointerMove={event => {
          const start = stripDrag.current;
          if (native && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) { stripDrag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); void getCurrentWindow().startDragging().catch(report); }
        }} onDoubleClick={event => { if (event.target === event.currentTarget) { event.stopPropagation(); open(browserCanvas(), false); } }} onDragOver={event => { if (event.dataTransfer.types.includes('application/x-canvas-tab')) event.preventDefault(); }} onDrop={event => {
          const raw = event.dataTransfer.getData('application/x-canvas-tab');
          if (!raw) return;
          event.preventDefault(); event.stopPropagation();
          try { const from = JSON.parse(raw); if (from.scope === key) change(old => moveTab(old, from.frame, from.tab, frame.id, (event.target as Element).closest<HTMLElement>('[data-tab]')?.dataset.tab)); } catch (error) { report(error); }
        }}>{frame.tabs.map(tab => {
          const Icon = canvasIcons[tab.kind];
          return <div className={`cw-tab ${tab.id === canvas.id ? 'is-active' : ''}`} key={tab.id} data-tab={tab.id} draggable onDragStart={event => { if (native && frame.tabs.length === 1) { event.preventDefault(); void getCurrentWindow().startDragging().catch(report); return; } event.dataTransfer.setData('application/x-canvas-tab', JSON.stringify({ scope: key, frame: frame.id, tab: tab.id })); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={event => {
              if (event.dataTransfer.dropEffect === 'none' && (event.clientX < 0 || event.clientY < 0 || event.clientX > window.innerWidth || event.clientY > window.innerHeight)) change(old => detachTab(old, frame.id, tab.id));
            }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close(tab.id); } }}>
            <button role="tab" aria-selected={tab.id === canvas.id} title={tab.kind === 'browser' ? tab.url || tab.title : tab.kind === 'web' ? tab.location : undefined} onClick={() => change(old => ({ ...old, frames: old.frames.map(row => row.id === frame.id ? { ...row, active: tab.id } : row) }))}><Icon size={14} className={pageLoading[tab.id] ? 'ds-spin' : ''} /><span>{tab.kind === 'content' ? scope?.path.split('/').filter(Boolean).slice(-1)[0] || scope?.workspace || 'Canvas' : tab.title}</span></button>
            <button className="cw-close-tab" title={`Close ${tab.title} tab`} aria-label={`Close ${tab.title} tab`} onClick={() => close(tab.id)}><X size={12} /></button>
          </div>;
        })}</div>
        <button className="ds-icon-button" aria-label="New tab" title="New tab · Ctrl+T · Shift for a new window" onClick={event => open(browserCanvas(), event.shiftKey)}><Plus size={16} /></button>
        <button className="ds-icon-button" aria-label="Open a web page" title="Open a web page · shift opens beside this canvas" onClick={event => open(browserCanvas(), event.shiftKey)}><Globe size={15} /></button>
        {frame.tabs.length > 1 && <button className="ds-icon-button" aria-label="Move tab to its own window" title="Move tab to its own window" onClick={() => change(old => detachTab(old, frame.id, canvas.id))}><ExternalLink size={15} /></button>}
        <button className="ds-icon-button" aria-label="Reuse window across navigation" aria-pressed={!!frame.pinned} title={frame.pinned ? 'Unpin window' : 'Pin window: keep this window and view while navigating'} onClick={() => change(old => ({ ...old, frames: old.frames.map(row => row.id === frame.id ? { ...row, pinned: !row.pinned } : row) }))}><Pin size={15} fill={frame.pinned ? 'currentColor' : 'none'} /></button>
        <button className="ds-icon-button" aria-label="Tile canvas windows" title="Tile canvas windows" onClick={services.tile}><Columns2 size={15} /></button>
        <WindowControls chrome={chrome} />
      </header>
      {frame.tabs.filter(tab => tab.kind === 'browser').map(tab => <PageTab key={tab.id} frame={frame} canvas={tab} active={browser && tab.id === canvas.id} chromeHeight={chromeHeight} loading={!!pageLoading[tab.id]} change={change} report={report} externally={browseExternally} drag={chrome.drag} />)}
      {!browser && <div className="cw-location" onPointerDown={chrome.drag}><span className="ds-live-dot" /><span>{scope && scopeUrl(scope)}</span><span className="cw-scope-label">CONTEXT</span></div>}
    </div>
    <div className="cw-content" role="tabpanel">
      {terminal && scope ? <AppletTargetProvider target={{ mode: 'workspace', workspaceName: scope.workspace, treeName: scope.tree, treeType: scope.treeType as 'context' | 'directory', path: scope.path }}><TerminalApplet /></AppletTargetProvider> : web ? <Suspense fallback={<div className="cw-empty" role="status"><Layers3 size={38} strokeWidth={1} /><p>Opening the canvas…</p></div>}><WebCanvas key={canvas.id} location={webLocation} onNavigate={webNavigate} onBack={webBack} kind={canvas.kind} windowView={windowView} open={(entry, side) => open(webCanvas(entry.location, entry.title), side)} /></Suspense> : browser ? canvas.url ? native ? <div className="cw-page-host" aria-label={`Page ${canvas.url}`} /> : <iframe className="cw-page" src={canvas.url} title={canvas.title} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" /> : <div className="cw-empty"><Globe size={36} strokeWidth={1} /><h2>A window to the web</h2><p>Websites open right here, as a tab in this canvas. Hold shift to open one beside it.</p><form onSubmit={event => { event.preventDefault(); const input = normalizeAddress(String(new FormData(event.currentTarget).get('url') || '')); if (input) change(old => patchTab(old, frame.id, canvas.id, browserCanvas(input))); }}><input type="text" name="url" aria-label="Website address" required autoFocus placeholder="example.com" inputMode="url" /><button className="ds-primary">Open <ArrowUpRight size={14} /></button></form></div> : null}
    </div>
    {error && browser && <div className="ds-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
  </section>;
}

/** One native page webview per URL tab; the address bar lives in the chrome. */
function PageTab({ frame, canvas, active, chromeHeight, loading, change, report, externally, drag }: { frame: Frame; canvas: Canvas; active: boolean; chromeHeight: number; loading: boolean; change: (fn: (layout: Layout) => Layout) => void; report: (error: unknown) => void; externally: (url: string) => void; drag: (event: React.PointerEvent) => void }) {
  const [draft, setDraft] = useState(canvas.url || '');
  const height = Math.max(40, chromeHeight);
  const address = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!active) return;
    const run = (name: string) => {
      if (name === 'address') { address.current?.focus(); address.current?.select(); }
      else if (native && canvas.url && ['reload', 'back', 'forward'].includes(name)) void pageAction(windowLabel, canvas.id, name as 'reload' | 'back' | 'forward').catch(report);
    };
    const keyboard = (event: KeyboardEvent) => { const name = tabShortcut(event); if (name && ['address', 'reload', 'back', 'forward'].includes(name)) { event.preventDefault(); run(name); } };
    window.addEventListener('keydown', keyboard);
    const listener = native ? listen<string>('desktop:tab-action', ({ payload }) => run(payload)) : undefined;
    return () => { window.removeEventListener('keydown', keyboard); void listener?.then(unlisten => unlisten()); };
  }, [active, canvas.id, canvas.url]);
  useEffect(() => setDraft(canvas.url || ''), [canvas.url]);
  useEffect(() => {
    if (!native || !canvas.url || observed.get(canvas.id) === canvas.url) return;
    observed.set(canvas.id, canvas.url);
    void pageOpen(windowLabel, canvas.id, canvas.url, height).catch(error => { if (observed.get(canvas.id) === canvas.url) observed.delete(canvas.id); report(error); });
  }, [canvas.url]);
  useEffect(() => {
    if (!native || !canvas.url) return;
    void (active ? pageShow(windowLabel, canvas.id, height) : pageHide(windowLabel, canvas.id)).catch(report);
  }, [active, height, !!canvas.url]);
  useEffect(() => () => { if (native) void pageHide(windowLabel, canvas.id).catch(() => {}); }, [canvas.id]);
  if (!active) return null;
  const action = (name: 'back' | 'forward' | 'reload' | 'stop') => { if (native && canvas.url) void pageAction(windowLabel, canvas.id, name).catch(report); };
  return <form className="cw-address" onPointerDown={drag} onSubmit={event => {
    event.preventDefault();
    const url = normalizeAddress(draft);
    if (url) change(old => patchTab(old, frame.id, canvas.id, { url, title: url === canvas.url ? canvas.title : browserCanvas(url).title }));
  }}>
    <button type="button" className="ds-icon-button" aria-label="Back" title="Back" disabled={!canvas.url} onClick={() => action('back')}><ArrowLeft size={15} /></button>
    <button type="button" className="ds-icon-button" aria-label="Forward" title="Forward" disabled={!canvas.url} onClick={() => action('forward')}><ArrowRight size={15} /></button>
    <button type="button" className="ds-icon-button" aria-label={loading ? 'Stop loading' : 'Reload page'} title={loading ? 'Stop' : 'Reload'} disabled={!canvas.url} onClick={() => action(loading ? 'stop' : 'reload')}>{loading ? <Square size={12} /> : <RefreshCw size={14} />}</button>
    <input ref={address} aria-label="Page address" value={draft} onChange={event => setDraft(event.target.value)} onFocus={event => event.currentTarget.select()} placeholder="Enter a website address" spellCheck={false} inputMode="url" />
    <button type="button" className="ds-icon-button" aria-label="Open in a separate browser window" title="Open in a separate browser window" disabled={!canvas.url} onClick={() => externally(canvas.url!)}><ExternalLink size={14} /></button>
  </form>;
}
