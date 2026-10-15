import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { CanvasApiClient } from '@augmentd-labs/canvas-api-client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ArrowRight, ArrowUpRight, Layers3, Plus, X } from 'lucide-react';
import { MainMenu } from '../components/main-menu/MainMenu';
import { Toolbox } from '../components/toolbox/Toolbox';
import { CanvasWindow } from '../components/canvas-window/CanvasWindow';
import { Settings } from '../components/settings/Settings';
import { createDesktopStore, useDesktopState } from './store';
import { addCanvas, cycleMenu, scopeKey, scopeUrl, updateLayout, type Scope } from './model';
import type { DesktopServices, DesktopWidget } from './integration';
import { native, surface, syncWindows, tileWindows, stopWindows } from './native';
import { installAutomation } from './automation';
import './desktop.css';

const MountSetup = lazy(() => import('./MountSetup'));
export const desktopWidgets: DesktopWidget[] = [
  { id: 'main-menu', title: 'Main menu', component: MainMenu },
  { id: 'toolbox', title: 'Toolbox', component: Toolbox },
];
type Account = { id: string; email?: string };
export default function Desktop({ url, changeServer }: { url: string; changeServer: () => void }) {
  const client = useMemo(() => new CanvasApiClient({ baseUrl: url, getToken: () => localStorage.getItem('authToken'), appName: 'canvas-desktop' }), [url]);
  const [account, setAccount] = useState<Account>();
  const [checking, setChecking] = useState(!!localStorage.getItem('authToken'));
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!localStorage.getItem('authToken')) { setChecking(false); return; }
    let active = true; setError(''); setChecking(true);
    void client.auth.me().then(value => { if (!value?.id) throw new Error('The server did not return an account identity.'); if (active) setAccount(value); }).catch(e => {
      if (!active) return;
      if (e.statusCode === 401 || e.statusCode === 403) localStorage.removeItem('authToken');
      setError(String(e));
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [client, retry]);
  useEffect(() => {
    const storageChanged = () => { if (!localStorage.getItem('authToken')) { setAccount(undefined); setChecking(false); } };
    window.addEventListener('storage', storageChanged);
    return () => window.removeEventListener('storage', storageChanged);
  }, []);
  async function logout() {
    await stopWindows().catch(e => setError(String(e)));
    try { await client.auth.logout(); } catch { /* Local logout must work offline. */ }
    localStorage.removeItem('authToken');
    // The shared web UI's document caches must not survive an account change.
    void import('@web/lib/offline').then(module => module.clearOfflineCaches()).catch(() => {});
    setAccount(undefined);
  }
  if (checking) return <div className="ds-auth"><div className="ds-auth-brand">canvas<span>.</span></div><p role="status">Opening your space…</p></div>;
  if (!account) return <Login client={client} url={url} error={error} connected={() => setRetry(value => value + 1)} changeServer={changeServer} />;
  return <Workspace key={account.id} client={client} account={account} logout={() => void logout()} changeServer={changeServer} />;
}
function Login({ client, url, error: initialError, connected, changeServer }: { client: CanvasApiClient; url: string; error: string; connected: () => void; changeServer: () => void }) {
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const [tokenMode, setTokenMode] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  async function login() {
    setBusy(true); setError('');
    try {
      if (tokenMode) {
        await new CanvasApiClient({ baseUrl: url, token: token.trim(), appName: 'canvas-desktop' }).auth.me();
        localStorage.setItem('authToken', token.trim());
      } else {
        const result = await client.auth.login({ email, password, strategy: 'auto' });
        const credential = result?.token || result?.payload?.token;
        if (!credential) throw new Error('The server did not return a session token.');
        localStorage.setItem('authToken', credential);
      }
      connected();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <main className="ds-auth"><div className="ds-auth-brand">canvas<span>.</span></div><span className="cw-eyebrow">A PLACE FOR EVERYTHING</span><h1>Make room for your work.</h1><p>Your notes, files, and conversations.<br />Together, wherever your focus goes.</p><form onSubmit={event => { event.preventDefault(); void login(); }}><h2>Welcome back</h2>{tokenMode ? <label>API token<input required type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label> : <><label>Email<input type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label></>}{error && <p className="ds-error" role="alert">{error}</p>}<button className="ds-primary" disabled={busy}>{busy ? 'Signing in…' : 'Enter your space'}<ArrowRight size={16} /></button><button type="button" className="ds-text-button" onClick={() => setTokenMode(value => !value)}>{tokenMode ? 'Sign in with email' : 'Use an API token'}</button><a className="ds-text-button" href="/login">More sign-in options <ArrowUpRight size={12} /></a></form><button className="ds-auth-server" onClick={changeServer}>{new URL(url).host} · Change server</button></main>;
}
function Workspace({ client, account, logout, changeServer }: { client: CanvasApiClient; account: Account; logout: () => void; changeServer: () => void }) {
  const store = useMemo(() => createDesktopStore(account.id), [account.id]);
  const state = useDesktopState(store);
  const [error, setError] = useState(store.error());
  const [settings, setSettings] = useState(false);
  const [mounts, setMounts] = useState(false);
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const boundKey = surface === 'canvas' ? query.get('scope') : null;
  const boundScope = useMemo(() => {
    if (!boundKey) return undefined;
    try { const [workspace, tree, treeType, path] = JSON.parse(boundKey); return { mode: 'explorer', workspace, tree, treeType, path } as Scope; } catch { return undefined; }
  }, [boundKey]);
  const scope = boundScope || state.scope;
  const key = scope ? scopeKey(scope) : '';
  const layout = state.layouts[key];
  const report = (error: unknown) => setError(String(error));
  const nativeKey = JSON.stringify([state.scope, layout?.frames.map(frame => [frame.id, frame.tabs.find(tab => tab.id === frame.active)?.title]), layout?.focused, layout?.arrangement, state.gap, state.placement, state.menu, state.toolbox.open]);
  const services: DesktopServices = { client, store, state, scope, layout, account: account.email || account.id, native, report, settings: () => setSettings(true), mounts: () => setMounts(true), logout, tile: () => { void tileWindows().catch(report); } };
  useEffect(() => () => store.dispose(), [store]);
  useEffect(() => installAutomation(store), [store]);
  useEffect(() => { void syncWindows(state, JSON.stringify([client.baseUrl, account.id])).catch(report); }, [nativeKey, store]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.repeat) return;
      try {
        if (event.ctrlKey && event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); store.update(old => ({ ...old, menu: cycleMenu(old.menu) })); if (native) void invoke('desktop_reveal_menu').catch(report); }
        else if (event.ctrlKey && event.altKey && event.code === 'Space') { event.preventDefault(); store.update(old => ({ ...old, toolbox: { ...old.toolbox, open: !old.toolbox.open } })); }
        else if (event.ctrlKey && event.altKey && event.code === 'KeyA') { event.preventDefault(); store.update(old => ({ ...old, toolbox: { ...old.toolbox, open: true, page: 'agents' } })); }
        else if (event.key === 'Escape') { setSettings(false); setMounts(false); store.update(old => ({ ...old, menu: 'hidden', toolbox: { ...old.toolbox, open: false } })); }
      } catch (e) { report(e); }
    };
    window.addEventListener('keydown', keyboard);
    if (!native) return () => window.removeEventListener('keydown', keyboard);
    let geometryTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners = [listen('desktop:geometry', () => {
      clearTimeout(geometryTimer);
      geometryTimer = setTimeout(() => { void invoke('desktop_save_geometry').catch(report); }, 350);
    }), listen<string>('desktop:action', ({ payload }) => {
      if (payload === 'settings') setSettings(true);
      else if (payload === 'mounts') setMounts(true);
      else if (payload === 'logout') logout();
      else if (payload === 'menu') store.update(old => ({ ...old, menu: old.menu === 'hidden' ? (old.scope ? 'm2' : 'm1') : 'hidden' }));
    }), listen('desktop:close', () => {
      if (surface === 'canvas') store.update(old => updateLayout(old, key, layout => {
        const frames = layout.frames.filter(frame => frame.id !== query.get('frame'));
        return { ...layout, frames, focused: frames.some(frame => frame.id === layout.focused) ? layout.focused : frames[0]?.id || '' };
      }));
    }), listen('desktop:focused', () => {
      if (surface === 'canvas' && store.get().scope && scopeKey(store.get().scope!) === key) store.update(old => updateLayout(old, key, layout => ({ ...layout, focused: query.get('frame') || layout.focused })));
    })];
    return () => { clearTimeout(geometryTimer); window.removeEventListener('keydown', keyboard); listeners.forEach(promise => { void promise.then(unlisten => unlisten()).catch(report); }); };
  }, [store, key]);
  const frame = surface === 'canvas' ? layout?.frames.find(frame => frame.id === query.get('frame')) : undefined;
  const visibleFrames = layout?.arrangement === 'focus' ? layout.frames.filter(frame => frame.id === layout.focused) : layout?.frames || [];
  return <div className={`ds-root ds-surface-${surface} ${native ? 'ds-native' : 'ds-preview'} ds-menu-${state.menu} ds-placement-${state.placement}`} style={{ '--ds-gap': `${state.gap}px` } as CSSProperties}>
    {surface === 'canvas' ? frame ? <CanvasWindow frame={frame} services={services} /> : <div className="ds-empty">This canvas has been closed.</div> : surface === 'toolbox' ? <Toolbox {...services} /> : <>
      <MainMenu {...services} />
      {!native && <main className="ds-stage"><header className="ds-stage-heading"><div><span className="cw-eyebrow">A SPACE THAT FOLLOWS YOUR FOCUS</span><span className="ds-stage-location">{scope ? scopeUrl(scope) : 'Welcome to your desktop'}</span></div><span className="ds-local-label"><span className="ds-live-dot" /> Saved on this device</span></header><div className={`ds-canvas-stage ds-arrangement-${layout?.arrangement || 'columns'} ds-count-${visibleFrames.length}`}>
        {visibleFrames.length ? visibleFrames.map(frame => <CanvasWindow key={`${key}:${frame.id}`} frame={frame} services={services} />) : <div className="ds-empty"><Layers3 size={44} strokeWidth={1} /><h1>Space for what matters.</h1><p>{scope ? 'Your layout is empty. Bring a canvas into focus.' : 'Choose a workspace to bring its content into focus.'}</p>{scope && <button className="ds-primary" onClick={() => store.update(old => updateLayout(old, key, layout => addCanvas(layout, 'content')))}><Plus size={15} /> Open a canvas</button>}</div>}
      </div><footer className="ds-stage-footer"><span>canvas <span> / </span> your context, collected</span><button onClick={changeServer}>Change server <ArrowUpRight size={11} /></button></footer></main>}
      {!native && <Toolbox {...services} />}
    </>}
    {error && <div className="ds-toast" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
    {settings && <Settings services={services} close={() => setSettings(false)} />}
    {mounts && <div className="ds-dialog-backdrop"><section className="ds-mounts" role="dialog" aria-modal="true" aria-label="Mounts and connections"><button className="ds-icon-button ds-mounts-close" autoFocus aria-label="Close mounts" onClick={() => setMounts(false)}><X size={18} /></button>{native ? <Suspense fallback={<p>Opening mounts…</p>}><MountSetup /></Suspense> : <p>Mount management is available in the native desktop app.</p>}</section></div>}
  </div>;
}
