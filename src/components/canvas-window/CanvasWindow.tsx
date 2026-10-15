import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, File, FileText, Globe, Layers3, Mail, MessageSquare, Plus, RefreshCw, Search, X, Columns2, ExternalLink } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { documentRoute, record, type CanvasKind } from '../../desktop-state';
import { closeTab, detachTab, addCanvas, scopeKey, scopeUrl, updateLayout, type Frame } from '../../shell/model';
import type { DesktopServices } from '../../shell/integration';
import './canvas-window.css';

export const canvasIcons = { content: Layers3, notes: FileText, emails: Mail, messages: MessageSquare, files: File, tabs: Globe, browser: Globe };
export const canvasNames: Record<CanvasKind, string> = { content: 'Everything', notes: 'Notes', emails: 'Email', messages: 'Messages', files: 'Files', tabs: 'Saved tabs', browser: 'Browser' };
type Doc = { id: string | number; schema?: string; data?: Record<string, unknown>; updatedAt?: string };
function text(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
function title(doc: Doc) { const data = record(doc.data); return text(data.title || data.subject || data.name || data.filename) || `Document ${doc.id}`; }
function excerpt(doc: Doc) { const data = record(doc.data); return text(data.text || data.bodyText || data.description || data.content || data.body); }
function kind(doc: Doc): CanvasKind {
  const schema = doc.schema || text(record(doc.data).schema);
  return schema.includes('email') ? 'emails' : schema.includes('message') ? 'messages' : schema.includes('note') ? 'notes' : schema.includes('tab') ? 'tabs' : 'files';
}
export function CanvasWindow({ frame, services }: { frame: Frame; services: DesktopServices }) {
  const { client, store, scope, layout, report, native } = services;
  const canvas = frame.tabs.find(tab => tab.id === frame.active)!;
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<Doc>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState(canvas.query || '');
  const key = scope ? scopeKey(scope) : '';
  const route = scope ? documentRoute(scope, canvas, offset) : '';
  const change = (fn: (layout: NonNullable<typeof layout>) => NonNullable<typeof layout>) => {
    try { store.update(state => updateLayout(state, key, fn)); } catch (e) { report(e); }
  };
  useEffect(() => { setOffset(0); setSelected(undefined); setQuery(canvas.query || ''); }, [key, canvas.id, canvas.query]);
  useEffect(() => {
    if (!route || canvas.kind === 'browser') { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(''); setDocs([]);
    void client.get(route, { signal: controller.signal }).then(value => {
      if (!Array.isArray(value)) throw new Error('The server returned an unexpected document list.');
      if (!controller.signal.aborted) setDocs(value);
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, route, revision, canvas.kind]);
  useEffect(() => {
    if (query === (canvas.query || '')) return;
    const timer = setTimeout(() => change(old => ({ ...old, frames: old.frames.map(row => row.id === frame.id ? { ...row, tabs: row.tabs.map(tab => tab.id === canvas.id ? { ...tab, query } : tab) } : row) })), 180);
    return () => clearTimeout(timer);
  }, [query]); // Keep immediate typing local; persist/filter after a short idle.
  async function browse(url: string) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use an HTTP or HTTPS address without credentials.');
      if (native) await invoke('open_browser', { url: parsed.href });
      else window.open(parsed.href, '_blank', 'noopener,noreferrer');
    } catch (e) { setError(String(e)); }
  }
  const focused = layout?.focused === frame.id;
  return <section className={`cw-window ${focused ? 'is-focused' : ''}`} aria-label={`${canvasNames[canvas.kind]} canvas`} onPointerDown={() => { if (!focused) change(old => ({ ...old, focused: frame.id })); }}>
    <header className="cw-titlebar">
      <div className="cw-tabs" role="tablist" aria-label="Canvas tabs">{frame.tabs.map(tab => {
        const Icon = canvasIcons[tab.kind];
        return <div className={`cw-tab ${tab.id === canvas.id ? 'is-active' : ''}`} key={tab.id}>
          <button role="tab" aria-selected={tab.id === canvas.id} onClick={() => change(old => ({ ...old, frames: old.frames.map(row => row.id === frame.id ? { ...row, active: tab.id } : row) }))}><Icon size={14} /><span>{tab.kind === 'content' ? 'Everything' : tab.title}</span></button>
          <button className="cw-close-tab" title={`Close ${tab.title} tab`} aria-label={`Close ${tab.title} tab`} onClick={() => change(old => closeTab(old, frame.id, tab.id))}><X size={12} /></button>
        </div>;
      })}</div>
      <button className="ds-icon-button" aria-label="Add content tab" title="Add content tab" onClick={() => change(old => addCanvas({ ...old, focused: frame.id }, 'content', true))}><Plus size={16} /></button>
      {frame.tabs.length > 1 && <button className="ds-icon-button" aria-label="Move tab to its own window" title="Move tab to its own window" onClick={() => change(old => detachTab(old, frame.id, canvas.id))}><ExternalLink size={15} /></button>}
      <button className="ds-icon-button" aria-label="Tile canvas windows" title="Tile canvas windows" onClick={services.tile}><Columns2 size={15} /></button>
    </header>
    <div className="cw-location"><span className="ds-live-dot" /><span>{scope && scopeUrl(scope)}</span><span className="cw-scope-label">CONTEXT</span></div>
    <div className="cw-content" role="tabpanel">
      {canvas.kind === 'browser' ? <div className="cw-empty"><Globe size={36} strokeWidth={1} /><h2>A window to the web</h2><p>Open a website in its own protected browser window.</p><form onSubmit={event => { event.preventDefault(); const input = new FormData(event.currentTarget).get('url'); if (input) void browse(String(input)); }}><input type="url" name="url" aria-label="Website address" required defaultValue={canvas.url} placeholder="https://…" /><button className="ds-primary">Open website <ArrowUpRight size={14} /></button></form></div> : selected ? <article className="cw-detail">
        <button className="ds-text-button" onClick={() => setSelected(undefined)}><ArrowLeft size={15} /> Back to {canvasNames[canvas.kind].toLowerCase()}</button><span className="cw-eyebrow">{canvasNames[kind(selected)]}</span><h1>{title(selected)}</h1><p className="cw-document-text">{excerpt(selected) || 'This document has no text preview.'}</p>
        {typeof selected.data?.url === 'string' && <button className="ds-text-button" onClick={() => void browse(selected.data!.url as string)}>Open source <ArrowUpRight size={14} /></button>}
      </article> : <>
        <div className="cw-heading"><div><span className="cw-eyebrow">YOUR CONTEXT, COLLECTED</span><h1>{canvasNames[canvas.kind]}<span>{loading ? '…' : docs.length === 50 ? '50+' : docs.length}</span></h1><p>{scope?.path === '/' ? 'A little space for the bigger picture.' : `Everything connected to ${scope?.path.split('/').filter(Boolean).at(-1) || 'this place'}.`}</p></div><button className="ds-icon-button" aria-label="Refresh content" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} className={loading ? 'ds-spin' : ''} /></button></div>
        <label className="cw-search"><Search size={16} /><input aria-label="Search this canvas" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find something in this canvas…" /><kbd>⌕</kbd></label>
        {loading ? <div className="cw-skeletons" role="status" aria-label="Loading content">{[1, 2, 3].map(i => <div key={i}><i /><span /><span /></div>)}</div> : error ? <div className="ds-error" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>Try again</button><button onClick={() => { void client.workspaces.start(scope!.workspace).then(() => setRevision(value => value + 1)).catch(report); }}>Start workspace</button></div> : docs.length ? <div className="cw-documents">{docs.map(doc => {
          const category = kind(doc); const Icon = canvasIcons[category]; const data = record(doc.data);
          return <button className={`cw-document cw-document-${category}`} key={doc.id} onClick={() => setSelected(doc)}><span className="cw-document-icon"><Icon size={20} strokeWidth={1.5} /></span><span className="cw-document-type">{canvasNames[category]}<ArrowUpRight size={13} /></span><strong>{title(doc)}</strong><span className="cw-excerpt">{excerpt(doc) || text(data.from) || 'Open to explore this document.'}</span><span className="cw-document-footer">{text(data.from) || text(data.filename) || 'In this context'}</span></button>;
        })}</div> : <div className="cw-empty"><Layers3 size={38} strokeWidth={1} /><h2>A little room to think.</h2><p>{query ? 'Nothing matches this search. Try another phrase.' : 'Notes, files, and conversations linked to this path will appear here.'}</p><a className="ds-text-button" href="/workspaces">Open workspace in the web UI <ArrowUpRight size={14} /></a></div>}
      </>}
    </div>
    <footer className="cw-footer"><span><span className="ds-live-dot" /> {loading ? 'Loading context' : 'Context connected'}</span><span className="cw-pagination"><button disabled={!offset || loading} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous</button><span>{offset + 1}–{offset + docs.length}</span><button disabled={docs.length < 50 || loading} onClick={() => setOffset(value => value + 50)}>Next</button></span></footer>
  </section>;
}
