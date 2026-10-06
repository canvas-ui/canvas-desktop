import { StrictMode, lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { scopedStorage, serverUrl } from './web-session';
import { TlsFields } from './TlsFields';
import type { ClientTls, Remote } from './backend';
type Setup = { remotes: Record<string, Remote> };
import './web-host.css';

const rawStorage = window.localStorage;
const connectionKey = 'canvas.desktop.connection';
const WebApp = lazy(() => import('@web/App'));

type Connection = { url: string; remote?: string };
async function start() {
  let setup: Setup | undefined;
  try { setup = { remotes: await invoke<Record<string, Remote>>('load_remotes') }; } catch { /* Web preview or unavailable native config: normal web login still works. */ }
  let connection: Connection | undefined;
  try { const saved = JSON.parse(rawStorage.getItem(connectionKey) || 'null'); if (saved?.url) connection = { url: serverUrl(saved.url), remote: saved.remote }; } catch { /* Invalid saved URL falls back to server selection. */ }
  let initialError = '';
  const desired = connection;
  if (connection) {
    try {
      if (setup) await invoke('activate_tls', { url: connection.url, tls: connection.remote ? setup.remotes[connection.remote]?.tls || null : null, allowImport: false });
      prepare(connection, setup);
    } catch (e) { initialError = String(e); connection = undefined; }
  }
  createRoot(document.getElementById('root')!).render(<StrictMode><Host initial={connection} desired={desired} setup={setup} initialError={initialError} /></StrictMode>);
}
function prepare(connection: Connection, setup?: Setup) {
  const storage = scopedStorage(rawStorage, connection.url, token => {
    if (connection.remote) void invoke('save_remote', { id: connection.remote, url: connection.url, token }).catch(() => {});
  });
  const remote = connection.remote ? setup?.remotes[connection.remote] : undefined;
  if (!storage.getItem('desktop.session.seeded')) {
    const token = remote?.auth?.token || remote?.device?.token;
    if (token) storage.setItem('authToken', token);
    storage.setItem('desktop.session.seeded', 'true');
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  window.__CANVAS_DESKTOP__ = { apiUrl: `${connection.url}/rest/v2`, serverOrigin: new URL(connection.url).origin };
  storage.setItem('appName', 'canvas-desktop');
}
function Host({ initial, desired, setup, initialError }: { initial?: Connection; desired?: Connection; setup?: Setup; initialError?: string }) {
  const [connection] = useState(initial);
  const [url, setUrl] = useState(desired?.url || initial?.url || 'http://127.0.0.1:8001');
  const [remote, setRemote] = useState(desired?.remote || initial?.remote || '');
  const [error, setError] = useState(initialError || '');
  const [tls, setTls] = useState<ClientTls | undefined>(desired?.remote ? setup?.remotes[desired.remote]?.tls : undefined);
  const [allowImport, setAllowImport] = useState(false);
  const [remoteName, setRemoteName] = useState('');
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(!initial);
  useEffect(() => {
    if (connection) void import('@web/lib/wallpaper').then(m => m.applyWallpaper());
  }, [connection]);
  async function connect() {
    setBusy(true); setError('');
    try {
      const address = serverUrl(url);
      const files = tls?.certFile || tls?.keyFile ? tls : undefined;
      const id = remote || (files ? remoteName : '');
      if (files && !id) throw new Error('Enter a remote name (user@remote-name) to save client certificate settings');
      if (setup && id) await invoke('save_remote_tls', { id, url: address, tls: files || null });
      if (setup && !connection) await invoke('activate_tls', { url: address, tls: files || null, allowImport });
      const next = { url: address, ...(id ? { remote: id } : {}) };
      rawStorage.setItem(connectionKey, JSON.stringify(next));
      // Full reload tears down all web services and singleton clients before
      // switching servers. Each server has its own storage namespace.
      if (setup && connection) {
        if (files) await invoke('prepare_tls_import', { url: address, tls: files, allowImport });
        await invoke('restart_connections');
      } else window.location.href = '/';
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <>
    {connection && <Suspense fallback={<div className="desktop-loading">Loading Canvas…</div>}><WebApp /></Suspense>}
    {connection && <button className="desktop-server-switch" title={connection.url} onClick={() => setSelecting(true)}>Server</button>}
    {selecting && <div className="desktop-connect-backdrop"><form className="desktop-connect" onSubmit={e => { e.preventDefault(); void connect(); }}>
      <h1>Connect to Canvas</h1><p>Choose a server, then sign in using the Canvas login screen.</p>
      {setup && Object.keys(setup.remotes).length > 0 && <label>Saved remote<select value={remote} onChange={e => { setRemote(e.target.value); const entry = setup.remotes[e.target.value]; if (entry) { setUrl(entry.url); setTls(entry.tls); } else setTls(undefined); }}><option value="">Enter a server address</option>{Object.keys(setup.remotes).map(id => <option key={id}>{id}</option>)}</select></label>}
      <label>Server address<input type="url" required value={url} onChange={e => { setUrl(e.target.value); setRemote(''); setTls(undefined); }} /></label>
      {setup && <TlsFields tls={tls} onChange={setTls} allowImport={allowImport} onImportChange={setAllowImport} />}
      {tls && !remote && <label>Remote name<input required value={remoteName} placeholder="user@remote-name" onChange={e => setRemoteName(e.target.value)} /></label>}
      {connection && <p>Continuing restarts Desktop to reconnect with fresh TLS sessions. Mounts keep running; restart them separately after certificate renewal.</p>}
      {error && <p role="alert">{error}</p>}<button type="submit" disabled={busy}>{busy ? 'Connecting…' : connection ? 'Save and reconnect' : 'Continue'}</button>{connection && <button type="button" onClick={() => setSelecting(false)}>Cancel</button>}
    </form></div>}
  </>;
}
void start();
