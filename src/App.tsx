import { useEffect, useMemo, useRef, useState } from 'react';
import Setup from './Setup';
import { useLiveBinding } from './use-live-binding';
import { version } from '../package.json';
import CanvasView from './CanvasView';
import * as backend from './backend';
import { kinds, newCanvas, pathRoute, readArrangement, treeBase, withArrangement, type Arrangement, type Binding, type Canvas, type CanvasKind } from './desktop-state';

type Context = { id: string; name?: string; url: string; workspaceName?: string; treeId?: string };
type Target = { binding: Binding; metadataRoute: string; context: boolean; key: string };
export default function App() {
  const [settings, setSettings] = useState(false);
  const [setup, setSetup] = useState<backend.Setup>();
  const [remote, setRemote] = useState('');
  const [mode, setMode] = useState<'explorer' | 'context'>('explorer');
  const [workspaces, setWorkspaces] = useState<backend.Workspace[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [trees, setTrees] = useState<backend.Tree[]>([]);
  const [tree, setTree] = useState('');
  const [paths, setPaths] = useState<string[]>([]);
  const [path, setPath] = useState('/');
  const [contexts, setContexts] = useState<Context[]>([]);
  const [contextPaths, setContextPaths] = useState<string[]>([]);
  const [contextId, setContextId] = useState('');
  const [pov, setPov] = useState('');
  const currentPov = useRef('');
  const [layout, setLayout] = useState<Arrangement>();
  const [target, setTarget] = useState<Target>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [kind, setKind] = useState<CanvasKind>('content');
  const [editing, setEditing] = useState<string>();
  const [dataRevision, setDataRevision] = useState(0);
  const client = useMemo(() => setup?.remotes[remote] ? backend.api(setup.remotes[remote]) : undefined, [setup, remote]);
  const selectedContext = contexts.find(c => c.id === contextId);
  const treeType = trees.find(t => t.name === tree)?.type || 'context';
  const selectionKey = JSON.stringify([remote, mode, workspace, tree, path, contextId, revision]);
  useLiveBinding(setup?.remotes[remote], client, target?.binding, url => {
    if (url && url !== currentPov.current) {
      currentPov.current = url;
      setContexts(old => old.map(c => c.id === contextId ? { ...c, url } : c));
      setPov(url);
    }
    setDataRevision(x => x + 1);
  });
  function leave(): boolean { return !dirty || window.confirm('Discard unsaved canvas arrangement changes?'); }
  function navigate(action: () => void) { if (!busy && leave()) { setDirty(false); setLayout(undefined); setTarget(undefined); setEditing(undefined); action(); } }
  useEffect(() => {
    let active = true;
    void backend.load().then(s => { if (active) { setSetup(s); setRemote(old => s.remotes[old] ? old : Object.keys(s.remotes)[0] || ''); } }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [settings]);
  useEffect(() => {
    let active = true;
    setWorkspaces([]); setContexts([]); setWorkspace(''); setContextId(''); setError('');
    if (client) void Promise.all([client.workspaces.list(), client.contexts.list()]).then(([ws, cs]) => {
      if (active) { setWorkspaces(ws); setContexts(cs); setWorkspace(ws[0]?.name || ''); setContextId(cs[0]?.id || ''); }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [client]);
  useEffect(() => {
    let active = true; setTrees([]); setTree(''); setPaths([]); setPath('/');
    if (client && workspace) void client.workspaces.trees(workspace).then((rows: backend.Tree[]) => {
      if (active) { const supported = rows.filter(t => ['context', 'directory'].includes(t.type)); setTrees(supported); setTree(supported[0]?.name || ''); }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [client, workspace, workspaceRevision]);
  useEffect(() => {
    let active = true; setPaths([]); setPath('/');
    if (client && workspace && tree) void client.get(`${treeBase(workspace, tree)}/paths`).then(rows => {
      if (active) setPaths(rows);
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [client, workspace, tree]);
  useEffect(() => {
    let active = true; setContextPaths([]);
    if (client && mode === 'context' && selectedContext?.workspaceName && selectedContext.treeId) {
      void client.get(`${treeBase(selectedContext.workspaceName, selectedContext.treeId)}/paths`).then(rows => {
        if (active) setContextPaths(rows);
      }).catch(e => { if (active) setError(String(e)); });
    }
    return () => { active = false; };
  }, [client, mode, selectedContext?.workspaceName, selectedContext?.treeId, workspaceRevision]);
  useEffect(() => {
    let active = true;
    setTarget(undefined); setLayout(undefined); setError(''); setDirty(false);
    if (!client || (mode === 'explorer' ? !workspace || !tree : !contextId)) return;
    const metadataRoute = mode === 'explorer' ? pathRoute(workspace, tree, path) : `/contexts/${encodeURIComponent(contextId)}`;
    void client.get(metadataRoute).then(value => {
      if (!active) return;
      setLayout(readArrangement(value.metadata));
      setTarget({ metadataRoute, context: mode === 'context', key: selectionKey, binding: mode === 'context' ? { mode, context: contextId } : { mode, workspace, tree, treeType, path } });
      if (mode === 'context') { currentPov.current = value.url || ''; setPov(currentPov.current); }
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [client, selectionKey]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);
  function change(canvases: Canvas[]) { setLayout(old => old ? { ...old, canvases } : old); setDirty(true); }
  function update(id: string, values: Partial<Canvas>) { if (layout) change(layout.canvases.map(c => c.id === id ? { ...c, ...values } : c)); }
  async function startWorkspace() {
    const name = mode === 'context' ? selectedContext?.workspaceName : workspace;
    if (!client || !name || !leave()) return;
    setBusy(true); setError('');
    try { await client.workspaces.start(name); setWorkspaceRevision(x => x + 1); setRevision(x => x + 1); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function save() {
    if (!client || !target || !layout) return;
    setBusy(true); setError('');
    try {
      // Re-read the owner immediately before merging; preserve filters and all
      // sibling metadata. The current API has no conditional metadata writes.
      const owner = await client.get(target.metadataRoute);
      const metadata = withArrangement(owner.metadata, layout);
      if (target.context) await client.put(target.metadataRoute, { metadata });
      else await client.patch(target.metadataRoute, { metadata });
      setDirty(false);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function movePov(nextUrl = pov) {
    if (!client || !contextId) return;
    setBusy(true); setError('');
    try {
      await client.post(`/contexts/${encodeURIComponent(contextId)}/url`, { url: nextUrl });
      // Preserve the context's arrangement, including any unsaved edits.
      const value = await client.contexts.get(contextId);
      setContexts(old => old.map(c => c.id === contextId ? value : c));
      currentPov.current = value.url;
      setPov(value.url);
      setDataRevision(x => x + 1);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  if (settings) return <><div className="settings-nav"><button onClick={() => setSettings(false)}>← Desktop</button></div><Setup /></>;
  return <div className="desktop-shell">
    <header className="desktop-header"><strong>Canvas Desktop</strong><select aria-label="Remote" disabled={busy} value={remote} onChange={e => navigate(() => setRemote(e.target.value))}><option value="">Select remote</option>{Object.keys(setup?.remotes || {}).map(id => <option key={id}>{id}</option>)}</select><button disabled={busy} onClick={() => { if (leave()) setSettings(true); }}>Mounts & connections</button></header>
    <aside className="desktop-sidebar"><nav aria-label="Navigation mode">{(['explorer', 'context'] as const).map(value => <button key={value} aria-pressed={mode === value} disabled={busy} onClick={() => navigate(() => setMode(value))}>{value === 'explorer' ? 'Explorer' : 'Contexts'}</button>)}</nav>
      {mode === 'explorer' ? <><label>Workspace<select disabled={busy} value={workspace} onChange={e => navigate(() => setWorkspace(e.target.value))}>{workspaces.map(w => <option key={w.name} value={w.name}>{w.label || w.name}</option>)}</select></label><label>Tree<select disabled={busy} value={tree} onChange={e => navigate(() => setTree(e.target.value))}>{trees.map(t => <option key={t.name} value={t.name}>{t.label || t.name}</option>)}</select></label><nav aria-label="Tree paths">{[...new Set(['/', ...paths])].map(p => <button key={p} title={p} aria-current={path === p ? 'page' : undefined} disabled={busy} onClick={() => navigate(() => setPath(p))}>{p}</button>)}</nav></> : <nav aria-label="Named contexts">{contexts.map(c => <button key={c.id} aria-current={contextId === c.id ? 'page' : undefined} disabled={busy} onClick={() => navigate(() => setContextId(c.id))}>{c.name || c.id}<small>{c.url}</small></button>)}</nav>}
      {mode === 'context' && selectedContext && <nav aria-label="Context tree paths"><p>Navigate POV</p>{[...new Set(['/', ...contextPaths])].map(p => <button key={p} disabled={busy || !target} aria-current={selectedContext.url === `${selectedContext.workspaceName}://${p.replace(/^\//, '')}` ? 'page' : undefined} onClick={() => void movePov(`${selectedContext.workspaceName}://${p.replace(/^\//, '')}`)}>{p}</button>)}</nav>}
      <button disabled={busy || !(mode === 'context' ? selectedContext?.workspaceName : workspace)} onClick={() => void startWorkspace()}>Start workspace</button>
      <footer><small>Canvas Desktop {version} · AGPL-3.0-or-later</small><a href="https://github.com/canvas-ui/canvas-desktop" target="_blank" rel="noreferrer">Source code</a></footer>
    </aside>
    <main className="desktop-main"><h1>{mode === 'explorer' ? `${workspace}/${path.replace(/^\//, '')}` : selectedContext?.name || contextId || 'Choose a context'}</h1>
      {mode === 'context' && contextId && <form className="pov-form" onSubmit={e => { e.preventDefault(); void movePov(); }}><label>Context POV<input aria-label="Context POV" value={pov} disabled={busy} onChange={e => setPov(e.target.value)} placeholder="work://dc-migration/task-2" /></label><button disabled={busy || !target}>Navigate</button></form>}
      <p className="owner-hint">{mode === 'explorer' ? 'Arrangement saved on this tree layer.' : 'Arrangement and filters stay with this context as its POV changes.'}</p>
      {error && <p role="alert" className="error">{error}</p>}
      {!remote && <p>Add a remote in Mounts & connections to begin.</p>}
      {layout && target && client && target.key === selectionKey && <>
        <div className="desktop-toolbar"><select aria-label="New canvas type" value={kind} disabled={busy} onChange={e => setKind(e.target.value as CanvasKind)}>{kinds.map(k => <option key={k}>{k}</option>)}</select><button disabled={busy} onClick={() => change([...layout.canvases, newCanvas(kind)])}>Add canvas</button><button disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save arrangement'}</button><button disabled={busy} onClick={() => navigate(() => setRevision(x => x + 1))}>Reload saved</button>{dirty && <span role="status">Unsaved arrangement</span>}</div>
        {!layout.canvases.length && <p>This desktop is empty. Add a canvas to start.</p>}
        <div className="canvas-grid">{layout.canvases.map((canvas, index) => <section className="desktop-canvas" key={canvas.id} style={{ gridColumn: `span ${canvas.width}`, height: canvas.height }}>
          <header><strong>{canvas.title}</strong><div><button aria-label={`Move ${canvas.title} left`} disabled={busy || index === 0} onClick={() => { const next = [...layout.canvases]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; change(next); }}>←</button><button aria-label={`Move ${canvas.title} right`} disabled={busy || index === layout.canvases.length - 1} onClick={() => { const next = [...layout.canvases]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; change(next); }}>→</button><button disabled={busy} onClick={() => setEditing(editing === canvas.id ? undefined : canvas.id)}>Settings</button><button aria-label={`Remove ${canvas.title}`} disabled={busy} onClick={() => change(layout.canvases.filter(c => c.id !== canvas.id))}>×</button></div></header>
          {editing === canvas.id && <fieldset className="canvas-settings" disabled={busy}><label>Title<input value={canvas.title} onChange={e => update(canvas.id, { title: e.target.value })} /></label><label>Width<select value={canvas.width} onChange={e => update(canvas.id, { width: Number(e.target.value) })}>{[1, 2, 3].map(n => <option key={n} value={n}>{n} columns</option>)}</select></label><label>Height<input type="number" min="200" max="1200" value={canvas.height} onChange={e => update(canvas.id, { height: Math.min(1200, Math.max(200, Number(e.target.value) || 200)) })} /></label>{canvas.kind === 'browser' ? <label>Address<input value={canvas.url || ''} onChange={e => update(canvas.id, { url: e.target.value })} /></label> : <label>Additional query<input value={canvas.query || ''} onChange={e => update(canvas.id, { query: e.target.value })} /></label>}</fieldset>}
          <CanvasView key={`${target.key}:${canvas.id}`} client={client} binding={target.binding} canvas={canvas} revision={dataRevision} scopeKey={mode === 'context' ? selectedContext?.url || '' : selectionKey} />
        </section>)}</div>
      </>}
    </main>
  </div>;
}
