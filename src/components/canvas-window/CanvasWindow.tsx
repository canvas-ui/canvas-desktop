import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, File, FileText, Globe, Layers3, Mail, MessageSquare, Plus, RefreshCw, Search, X, Columns2, ExternalLink, Square } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { documentRoute, record, type Canvas, type CanvasKind } from '../../desktop-state';
import { browserCanvas, closeTab, detachTab, addCanvas, openTab, patchTab, scopeKey, scopeUrl, updateLayout, type Frame, type Layout } from '../../shell/model';
import type { DesktopServices } from '../../shell/integration';
import { native, windowLabel, pageAction, pageClose, pageHide, pageOpen, pageShow } from '../../shell/native';
import { ResizeEdges, WindowControls, useWindowChrome } from '../../shell/chrome';
import './canvas-window.css';

export const canvasIcons = { content: Layers3, notes: FileText, emails: Mail, messages: MessageSquare, files: File, tabs: Globe, browser: Globe };
export const canvasNames: Record<CanvasKind, string> = { content: 'Everything', notes: 'Notes', emails: 'Email', messages: 'Messages', files: 'Files', tabs: 'Saved tabs', browser: 'Web page' };
type Doc = { id: string | number; schema?: string; data?: Record<string, unknown>; updatedAt?: string };
type PageEvent = { tab: string; url?: string; title?: string; loading?: boolean };
function text(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
function title(doc: Doc) { const data = record(doc.data); return text(data.title || data.subject || data.name || data.filename) || `Document ${doc.id}`; }
function excerpt(doc: Doc) { const data = record(doc.data); return text(data.text || data.bodyText || data.description || data.content || data.body); }
function kind(doc: Doc): CanvasKind {
  const schema = doc.schema || text(record(doc.data).schema);
  return schema.includes('email') ? 'emails' : schema.includes('message') ? 'messages' : schema.includes('note') ? 'notes' : schema.includes('tab') ? 'tabs' : 'files';
}
/** Addresses typed without a scheme are websites. */
export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
}
// Page URLs reported by the native webview must not be navigated to again.
const observed = new Map<string, string>();

export function CanvasWindow({ frame, services }: { frame: Frame; services: DesktopServices }) {
  const { client, store, scope, layout, report } = services;
  const canvas = frame.tabs.find(tab => tab.id === frame.active)!;
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<Doc>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState(canvas.query || '');
  const [pageLoading, setPageLoading] = useState<Record<string, boolean>>({});
  const [chromeHeight, setChromeHeight] = useState(0);
  const chromeRef = useRef<HTMLDivElement>(null);
  const chrome = useWindowChrome(report);
  const key = scope ? scopeKey(scope) : '';
  const route = scope ? documentRoute(scope, canvas, offset) : '';
  const lastRoute = useRef('');
  const change = (fn: (layout: Layout) => Layout) => {
    try { store.update(state => updateLayout(state, key, fn)); } catch (e) { report(e); }
  };
  /** Open a canvas from this frame: tab by default, to the side on shift. */
  const open = (next: Canvas, side: boolean) => {
    change(old => openTab(old, next, { frame: frame.id, side }));
    if (side) services.tile();
  };
  useEffect(() => {
    if (native) {
      const listener = listen<string>('desktop:content-changed', event => { if (event.payload === key) setRevision(value => value + 1); });
      return () => { void listener.then(unlisten => unlisten()).catch(() => {}); };
    }
    const refresh = (event: Event) => { if ((event as CustomEvent).detail === key) setRevision(value => value + 1); };
    window.addEventListener('desktop:content-changed', refresh);
    return () => window.removeEventListener('desktop:content-changed', refresh);
  }, [key, native]);
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
  useEffect(() => { setOffset(0); setSelected(undefined); setQuery(canvas.query || ''); }, [key, canvas.id, canvas.query]);
  useEffect(() => {
    if (!route || canvas.kind === 'browser') { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError('');
    if (lastRoute.current !== route) { setDocs([]); lastRoute.current = route; }
    void client.get(route, { signal: controller.signal }).then(value => {
      if (!Array.isArray(value)) throw new Error('The server returned an unexpected document list.');
      if (!controller.signal.aborted) { setDocs(value); setSelected(old => old ? value.find((doc: Doc) => doc.id === old.id) : undefined); }
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, route, revision, canvas.kind]);
  useEffect(() => {
    if (query === (canvas.query || '')) return;
    const timer = setTimeout(() => change(old => patchTab(old, frame.id, canvas.id, { query })), 180);
    return () => clearTimeout(timer);
  }, [query]); // Keep immediate typing local; persist/filter after a short idle.
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
  return <section className={`cw-window ${focused ? 'is-focused' : ''} ${browser ? 'is-browser' : ''}`} aria-label={`${canvasNames[canvas.kind]} canvas`} onPointerDown={() => { if (!focused) change(old => ({ ...old, focused: frame.id })); }} onClickCapture={event => {
    // Web links open inside the canvas: a tab here, or beside it with shift.
    const link = (event.target as Element).closest('a[href]');
    const href = link?.getAttribute('href') || '';
    if (link && /^https?:\/\//i.test(href)) { event.preventDefault(); event.stopPropagation(); open(browserCanvas(href, link.textContent?.trim() || undefined), event.shiftKey); }
  }}>
    <ResizeEdges chrome={chrome} />
    <div className="cw-chrome" ref={chromeRef}>
      <header className="cw-titlebar" onPointerDown={chrome.drag}>
        <div className="cw-tabs" role="tablist" aria-label="Canvas tabs">{frame.tabs.map(tab => {
          const Icon = canvasIcons[tab.kind];
          return <div className={`cw-tab ${tab.id === canvas.id ? 'is-active' : ''}`} key={tab.id}>
            <button role="tab" aria-selected={tab.id === canvas.id} title={tab.kind === 'browser' ? tab.url || tab.title : undefined} onClick={() => change(old => ({ ...old, frames: old.frames.map(row => row.id === frame.id ? { ...row, active: tab.id } : row) }))}><Icon size={14} className={pageLoading[tab.id] ? 'ds-spin' : ''} /><span>{tab.kind === 'content' ? 'Everything' : tab.title}</span></button>
            <button className="cw-close-tab" title={`Close ${tab.title} tab`} aria-label={`Close ${tab.title} tab`} onClick={() => change(old => closeTab(old, frame.id, tab.id))}><X size={12} /></button>
          </div>;
        })}</div>
        <button className="ds-icon-button" aria-label="New tab" title="New tab · shift for a new window" onClick={event => open(event.shiftKey ? browserCanvas() : { ...addCanvas({ frames: [], focused: '', arrangement: 'columns' }, 'content').frames[0].tabs[0] }, event.shiftKey)}><Plus size={16} /></button>
        <button className="ds-icon-button" aria-label="Open a web page" title="Open a web page · shift opens beside this canvas" onClick={event => open(browserCanvas(), event.shiftKey)}><Globe size={15} /></button>
        {frame.tabs.length > 1 && <button className="ds-icon-button" aria-label="Move tab to its own window" title="Move tab to its own window" onClick={() => change(old => detachTab(old, frame.id, canvas.id))}><ExternalLink size={15} /></button>}
        <button className="ds-icon-button" aria-label="Tile canvas windows" title="Tile canvas windows" onClick={services.tile}><Columns2 size={15} /></button>
        <WindowControls chrome={chrome} />
      </header>
      {browser ? frame.tabs.filter(tab => tab.kind === 'browser').map(tab => <PageTab key={tab.id} frame={frame} canvas={tab} active={tab.id === canvas.id} chromeHeight={chromeHeight} loading={!!pageLoading[tab.id]} change={change} report={report} externally={browseExternally} drag={chrome.drag} />)
        : <div className="cw-location" onPointerDown={chrome.drag}><span className="ds-live-dot" /><span>{scope && scopeUrl(scope)}</span><span className="cw-scope-label">CONTEXT</span></div>}
    </div>
    <div className="cw-content" role="tabpanel">
      {browser ? canvas.url ? native ? <div className="cw-page-host" aria-label={`Page ${canvas.url}`} /> : <iframe className="cw-page" src={canvas.url} title={canvas.title} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" /> : <div className="cw-empty"><Globe size={36} strokeWidth={1} /><h2>A window to the web</h2><p>Websites open right here, as a tab in this canvas. Hold shift to open one beside it.</p><form onSubmit={event => { event.preventDefault(); const input = normalizeAddress(String(new FormData(event.currentTarget).get('url') || '')); if (input) change(old => patchTab(old, frame.id, canvas.id, browserCanvas(input))); }}><input type="text" name="url" aria-label="Website address" required autoFocus placeholder="example.com" inputMode="url" /><button className="ds-primary">Open <ArrowUpRight size={14} /></button></form></div> : selected ? <article className="cw-detail">
        <button className="ds-text-button" onClick={() => setSelected(undefined)}><ArrowLeft size={15} /> Back to {canvasNames[canvas.kind].toLowerCase()}</button><span className="cw-eyebrow">{canvasNames[kind(selected)]}</span><h1>{title(selected)}</h1><p className="cw-document-text">{excerpt(selected) || 'This document has no text preview.'}</p>
        {typeof selected.data?.url === 'string' && <button className="ds-text-button" title="Open as a tab · shift opens beside this canvas" onClick={event => open(browserCanvas(selected.data!.url as string, title(selected)), event.shiftKey)}>Open source <ArrowUpRight size={14} /></button>}
      </article> : <>
        <div className="cw-heading"><div><span className="cw-eyebrow">YOUR CONTEXT, COLLECTED</span><h1>{canvasNames[canvas.kind]}<span>{loading ? '…' : docs.length === 50 ? '50+' : docs.length}</span></h1><p>{scope?.path === '/' ? 'A little space for the bigger picture.' : `Everything connected to ${scope?.path.split('/').filter(Boolean).slice(-1)[0] || 'this place'}.`}</p></div><button className="ds-icon-button" aria-label="Refresh content" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} className={loading ? 'ds-spin' : ''} /></button></div>
        <label className="cw-search"><Search size={16} /><input aria-label="Search this canvas" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find something in this canvas…" /><kbd>⌕</kbd></label>
        {loading && !docs.length ? <div className="cw-skeletons" role="status" aria-label="Loading content">{[1, 2, 3].map(i => <div key={i}><i /><span /><span /></div>)}</div> : error ? <div className="ds-error" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>Try again</button><button onClick={() => { void client.workspaces.start(scope!.workspace).then(() => setRevision(value => value + 1)).catch(report); }}>Start workspace</button></div> : docs.length ? <div className="cw-documents">{docs.map(doc => {
          const category = kind(doc); const Icon = canvasIcons[category]; const data = record(doc.data);
          const url = category === 'tabs' && typeof data.url === 'string' ? data.url : '';
          return <button className={`cw-document cw-document-${category}`} key={doc.id} title={url ? `${url} · click opens a tab, shift opens beside this canvas` : undefined} onClick={event => url ? open(browserCanvas(url, title(doc)), event.shiftKey) : setSelected(doc)}><span className="cw-document-icon"><Icon size={20} strokeWidth={1.5} /></span><span className="cw-document-type">{canvasNames[category]}<ArrowUpRight size={13} /></span><strong>{title(doc)}</strong><span className="cw-excerpt">{excerpt(doc) || text(data.from) || 'Open to explore this document.'}</span><span className="cw-document-footer">{text(data.from) || text(data.filename) || 'In this context'}</span></button>;
        })}</div> : <div className="cw-empty"><Layers3 size={38} strokeWidth={1} /><h2>A little room to think.</h2><p>{query ? 'Nothing matches this search. Try another phrase.' : 'Notes, files, and conversations linked to this path will appear here.'}</p><a className="ds-text-button" href="/workspaces">Open workspace in the web UI <ArrowUpRight size={14} /></a></div>}
      </>}
    </div>
    {!browser && <footer className="cw-footer"><span><span className="ds-live-dot" /> {loading ? 'Loading context' : error ? 'Could not load content' : 'Context connected'}</span><span className="cw-pagination"><button disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous</button><span>{docs.length ? offset + 1 : 0}–{offset + docs.length}</span><button disabled={docs.length < 50 || loading} onClick={() => setOffset(value => value + 50)}>Next</button></span></footer>}
    {error && browser && <div className="ds-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
  </section>;
}

/** One native page webview per URL tab; the address bar lives in the chrome. */
function PageTab({ frame, canvas, active, chromeHeight, loading, change, report, externally, drag }: { frame: Frame; canvas: Canvas; active: boolean; chromeHeight: number; loading: boolean; change: (fn: (layout: Layout) => Layout) => void; report: (error: unknown) => void; externally: (url: string) => void; drag: (event: React.PointerEvent) => void }) {
  const [draft, setDraft] = useState(canvas.url || '');
  const height = Math.max(40, chromeHeight);
  useEffect(() => setDraft(canvas.url || ''), [canvas.url]);
  useEffect(() => {
    if (!native || !canvas.url || observed.get(canvas.id) === canvas.url) return;
    observed.set(canvas.id, canvas.url);
    void pageOpen(windowLabel, canvas.id, canvas.url, height).catch(report);
  }, [canvas.url]);
  useEffect(() => {
    if (!native || !canvas.url) return;
    void (active ? pageShow(windowLabel, canvas.id, height) : pageHide(windowLabel, canvas.id)).catch(report);
  }, [active, height, !!canvas.url]);
  useEffect(() => () => { observed.delete(canvas.id); if (native) void pageClose(windowLabel, canvas.id).catch(() => {}); }, [canvas.id]);
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
    <input aria-label="Page address" value={draft} onChange={event => setDraft(event.target.value)} onFocus={event => event.currentTarget.select()} placeholder="Enter a website address" spellCheck={false} inputMode="url" />
    <button type="button" className="ds-icon-button" aria-label="Open in a separate browser window" title="Open in a separate browser window" disabled={!canvas.url} onClick={() => externally(canvas.url!)}><ExternalLink size={14} /></button>
  </form>;
}
