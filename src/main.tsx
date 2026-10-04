import { StrictMode, lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { scopedStorage, serverUrl } from './web-session';
import type { Remote } from './backend';
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
  if (connection) prepare(connection, setup);
  createRoot(document.getElementById('root')!).render(<StrictMode><Host initial={connection} setup={setup} /></StrictMode>);
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
function Host({ initial, setup }: { initial?: Connection; setup?: Setup }) {
  const [connection] = useState(initial);
  const [url, setUrl] = useState(initial?.url || 'http://127.0.0.1:8001');
  const [remote, setRemote] = useState(initial?.remote || '');
  const [error, setError] = useState('');
  const [selecting, setSelecting] = useState(!initial);
  useEffect(() => {
    if (connection) void import('@web/lib/wallpaper').then(m => m.applyWallpaper());
  }, [connection]);
  function connect() {
    try {
      const next = { url: serverUrl(url), ...(remote ? { remote } : {}) };
      rawStorage.setItem(connectionKey, JSON.stringify(next));
      // Full reload tears down all web services and singleton clients before
      // switching servers. Each server has its own storage namespace.
      window.location.href = '/';
    } catch (e) { setError(String(e)); }
  }
  return <>
    {connection && <Suspense fallback={<div className="desktop-loading">Loading Canvas…</div>}><WebApp /></Suspense>}
    {connection && <button className="desktop-server-switch" title={connection.url} onClick={() => setSelecting(true)}>Server</button>}
    {selecting && <div className="desktop-connect-backdrop"><form className="desktop-connect" onSubmit={e => { e.preventDefault(); connect(); }}>
      <h1>Connect to Canvas</h1><p>Choose a server, then sign in using the Canvas login screen.</p>
      {setup && Object.keys(setup.remotes).length > 0 && <label>Saved remote<select value={remote} onChange={e => { setRemote(e.target.value); const entry = setup.remotes[e.target.value]; if (entry) setUrl(entry.url); }}><option value="">Enter a server address</option>{Object.keys(setup.remotes).map(id => <option key={id}>{id}</option>)}</select></label>}
      <label>Server address<input type="url" required value={url} onChange={e => { setUrl(e.target.value); setRemote(''); }} /></label>
      {error && <p role="alert">{error}</p>}<button type="submit">Continue</button>{connection && <button type="button" onClick={() => setSelecting(false)}>Cancel</button>}
    </form></div>}
  </>;
}
void start();
