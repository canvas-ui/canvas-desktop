import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CanvasApiClient } from '@augmentd-labs/canvas-api-client';
import { documentRoute, record, type Binding, type Canvas } from './desktop-state';

type Doc = { id: string | number; schema?: string; data?: Record<string, unknown> };
export default function CanvasView({ client, binding, canvas, revision, scopeKey }: { client: CanvasApiClient; binding: Binding; canvas: Canvas; revision: number; scopeKey: string }) {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selected, setSelected] = useState<Doc>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const route = documentRoute(binding, canvas, offset);
  useEffect(() => { setOffset(0); setSelected(undefined); }, [binding, scopeKey]);
  useEffect(() => {
    if (canvas.kind === 'browser') return;
    const controller = new AbortController();
    setLoading(true); setError(''); setDocs([]);
    void client.get(route, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) {
        if (!Array.isArray(value)) throw new Error('Unexpected document response');
        setDocs(value);
        setSelected(old => old ? value.find((doc: Doc) => doc.id === old.id) : undefined);
      }
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, route, refresh, canvas.kind, revision, scopeKey]);
  async function browse(url: unknown) {
    try {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Use an HTTP or HTTPS address');
      await invoke('open_browser', { url });
    } catch (e) { setError(String(e)); }
  }
  if (canvas.kind === 'browser') return <div className="canvas-body"><p>{canvas.url || 'Set an address in the canvas settings.'}</p><button disabled={!canvas.url} onClick={() => void browse(canvas.url)}>Open native browser window</button><p>Browser windows are separate from this layout in the initial host.</p>{error && <p role="alert">{error}</p>}</div>;
  return <div className="canvas-body">
    <div className="canvas-tools"><button onClick={() => setRefresh(x => x + 1)}>Refresh</button><button disabled={offset === 0 || loading} onClick={() => setOffset(x => Math.max(0, x - 50))}>Previous</button><button disabled={docs.length < 50 || loading} onClick={() => setOffset(x => x + 50)}>Next</button></div>
    {loading && <p role="status">Loading…</p>}{error && <p role="alert" className="error">{error}</p>}
    {!loading && !error && !docs.length && <p>No matching content.</p>}
    {selected ? <div><button onClick={() => setSelected(undefined)}>← Back to list</button><h3>{String(selected.data?.title || selected.data?.subject || selected.id)}</h3><p className="document-text">{String(selected.data?.text || selected.data?.bodyText || selected.data?.body || selected.data?.content || selected.data?.description || 'No text preview available for this document.')}</p>{typeof selected.data?.url === 'string' && <button onClick={() => void browse(selected.data?.url)}>Open in browser</button>}</div> : <ul className="documents">{docs.map(doc => {
      const data = record(doc.data);
      return <li key={doc.id}><button onClick={() => setSelected(doc)}><strong>{String(data.title || data.subject || data.name || data.filename || doc.id)}</strong><small>{String(data.from || data.description || doc.schema?.split('/').pop() || '')}</small></button></li>;
    })}</ul>}
  </div>;
}
