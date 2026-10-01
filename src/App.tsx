import { version } from "../package.json";
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as backend from './backend';

export default function App() {
  const [setup, setSetup] = useState<backend.Setup>();
  const [remote, setRemote] = useState('');
  const [workspaces, setWorkspaces] = useState<backend.Workspace[]>([]);
  const [trees, setTrees] = useState<Record<string, backend.Tree[]>>({});
  const [status, setStatus] = useState<backend.Status>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [credentials, setCredentials] = useState({ id: '', url: '', email: '', password: '', token: '' });
  async function task(fn: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function refreshStatus() { setStatus(await backend.status()); }
  useEffect(() => {
    let disposed = false;
    const listeners = [
      listen('mounts:changed', () => { void refreshStatus().catch(e => setError(String(e))); }),
      listen<string>('mounts:error', event => setError(event.payload)),
    ];
    void backend.load().then(s => { if (!disposed) { setSetup(s); setRemote(Object.keys(s.remotes)[0] || ''); } }).catch(e => setError(String(e)));
    void refreshStatus().catch(e => setError(String(e)));
    const timer = setInterval(() => { void refreshStatus().catch(e => setError(String(e))); }, 5000);
    return () => { disposed = true; clearInterval(timer); listeners.forEach(p => { void p.then(unlisten => unlisten()); }); };
  }, []);
  useEffect(() => {
    if (!remote || !setup?.remotes[remote]) { setWorkspaces([]); return; }
    let disposed = false;
    setWorkspaces([]); setTrees({}); setError('');
    const client = backend.api(setup.remotes[remote]);
    void (async () => {
      const rows: backend.Workspace[] = await client.workspaces.list();
      if (disposed) return;
      setWorkspaces(rows);
      // A stopped/unavailable workspace may not expose its trees yet. Surface
      // the failure without discarding other workspaces or assuming tree names.
      for (const row of rows) {
        try {
          const entries: backend.Tree[] = await client.workspaces.trees(row.name);
          if (!disposed) setTrees(prev => ({ ...prev, [row.name]: entries.filter(t => ['context', 'directory'].includes(t.type)) }));
        } catch (e) { if (!disposed) setError(`Trees for ${row.name}: ${String(e)}`); }
      }
    })().catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [remote, setup?.remotes]);
  function updateMount(workspace: string, exp: backend.Mount['export'], tree: string | null, mode: string) {
    if (!setup) return;
    const mounts = setup.config.mounts.filter(m => !(m.remote === remote && m.workspace === workspace && m.export === exp && m.tree === tree));
    if (mode) mounts.push({ remote, workspace, export: exp, tree, mode: mode as backend.Mount['mode'] });
    setSetup({ ...setup, config: { ...setup.config, mounts } }); setDirty(true);
  }
  function selection(workspace: string, exp: backend.Mount['export'], tree: string | null) {
    return setup?.config.mounts.find(m => m.remote === remote && m.workspace === workspace && m.export === exp && m.tree === tree)?.mode || '';
  }
  function exportRow(workspace: string, exp: backend.Mount['export'], label: string, tree: string | null = null) {
    return <label key={`${exp}:${tree}`} className="row"><span>{label}</span><select disabled={busy} value={selection(workspace, exp, tree)} onChange={e => updateMount(workspace, exp, tree, e.target.value)}>
      <option value="">Disabled</option><option value="mount">Mount only</option>{exp === 'home' && <option value="mirror">Mirror</option>}
    </select></label>;
  }
  return <main>
    <h1>Canvas Desktop</h1><p>Connect a server, choose workspace exports, then manage their mounts from the tray.</p>
    {error && <p role="alert" className="error">{error}</p>}{message && <p role="status">{message}</p>}
    <fieldset disabled={busy}><legend>Add or sign in to a remote</legend>
      <form onSubmit={e => { e.preventDefault(); void task(async () => {
        await backend.login(credentials.id, credentials.url, credentials.email, credentials.password, credentials.token);
        const loaded = await backend.load();
        setSetup(prev => ({ ...loaded, config: prev?.config || loaded.config })); setRemote(credentials.id);
        setCredentials({ id: '', url: '', email: '', password: '', token: '' }); setMessage('Remote saved.');
      }); }}>
        {(['id', 'url', 'email', 'password', 'token'] as const).map(key => <label key={key}>{({ id: 'Remote name (user@remote-name)', url: 'Server URL', email: 'Email', password: 'Password', token: 'API token (alternative to email/password)' })[key]}
          <input required={key === 'id' || key === 'url'} type={key === 'password' || key === 'token' ? 'password' : key === 'url' ? 'url' : key === 'email' ? 'email' : 'text'} value={credentials[key]} onChange={e => setCredentials({ ...credentials, [key]: e.target.value })} />
        </label>)}<button>Sign in and save remote</button>
      </form>
    </fieldset>
    {setup && <>
      <fieldset disabled={busy}><legend>Workspace exports</legend>
        <label>Remote<select value={remote} onChange={e => setRemote(e.target.value)}><option value="">Choose remote</option>{Object.keys(setup.remotes).map(id => <option key={id}>{id}</option>)}</select></label>
        <label>Workspaces root folder<input value={setup.config.workspaceRoot} onChange={e => { setSetup({ ...setup, config: { ...setup.config, workspaceRoot: e.target.value } }); setDirty(true); }} /></label>
        <p>Paths: root / remote / workspace / Home, Trees / tree, or Contexts. Mirror keeps Home files locally and uploads writes; remote deletes use trash.</p>
        {workspaces.map(ws => <section key={ws.name}><h3>{ws.label || ws.name}</h3>
          {exportRow(ws.name, 'home', 'Home')}{exportRow(ws.name, 'contexts', 'Contexts')}
          {(trees[ws.name] || []).map(tree => exportRow(ws.name, 'tree', `${tree.label || tree.name} (${tree.type} tree)`, tree.name))}
        </section>)}
        <button onClick={() => { void task(async () => { await backend.save(setup.config); setDirty(false); await refreshStatus(); setMessage('Mount plan saved.'); }); }}>Save mount plan</button>
      </fieldset>
      <h2>Mounts</h2><p>canvas-fuse: {status?.fuseAvailable ? 'available' : 'missing'} · PM2: {status?.pm2Available ? 'available' : 'missing'}</p>
      {dirty && <p>Save the plan before managing mounts.</p>}
      {setup.config.mounts.map((mount, i) => <section key={`${mount.remote}:${mount.workspace}:${mount.export}:${mount.tree}`}>
        <strong>{mount.remote} / {mount.workspace} / {mount.tree || mount.export} ({mount.mode})</strong>
        {!dirty && <p>{status?.mounts[i]?.path}<br />Process: {status?.mounts[i]?.process || 'stopped'} · Filesystem: {status?.mounts[i]?.fuse?.mounted ? 'mounted' : 'unmounted'}</p>}
        {['start', 'stop', 'restart'].map(operation => <button key={operation} disabled={busy || dirty || !status?.fuseAvailable || !status?.pm2Available} onClick={() => { void task(async () => { await backend.action(i, operation); await refreshStatus(); }); }}>{operation}</button>)}
      </section>)}
    </>}
    <footer>Canvas Desktop {version} · AGPL-3.0-or-later · <a href="https://github.com/canvas-ui/canvas-desktop" target="_blank" rel="noreferrer">Source code</a></footer>
  </main>;
}
