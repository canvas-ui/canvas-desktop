import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Bot, ChevronDown, ChevronRight, Folder, FolderOpen, Grid2X2, HardDrive, Layers3, LogOut, PanelLeftClose, Search, Settings2, Sparkles } from 'lucide-react';
import { treeBase } from '../../desktop-state';
import type { Workspace, Tree } from '../../backend';
import { navigate, normalizePath, scopeUrl, type Scope } from '../../shell/model';
import type { DesktopServices } from '../../shell/integration';
import './main-menu.css';

export function MainMenu(services: DesktopServices) {
  const { client, state, store, scope, report } = services;
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspace, setWorkspace] = useState(scope?.workspace || '');
  const [trees, setTrees] = useState<Tree[]>([]);
  const [tree, setTree] = useState(scope?.tree || '');
  const [paths, setPaths] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const update = (menu: typeof state.menu) => { try { store.update(old => ({ ...old, menu })); } catch (e) { report(e); } };
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void client.workspaces.list().then(rows => { if (active) { setWorkspaces(rows); setWorkspace(old => rows.some((row: Workspace) => row.name === old) ? old : rows[0]?.name || ''); } }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, retry]);
  useEffect(() => {
    if (!workspace) return;
    let active = true; setTrees([]); setPaths([]); setError(''); setLoading(true);
    void client.workspaces.trees(workspace).then((rows: Tree[]) => {
      if (!active) return;
      const supported = rows.filter(row => ['context', 'directory'].includes(row.type));
      setTrees(supported);
      setTree(old => supported.some(row => row.name === old) ? old : supported[0]?.name || '');
    }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, workspace, retry]);
  const selectedTree = trees.find(row => row.name === tree);
  useEffect(() => {
    if (!workspace || !selectedTree) return;
    let active = true; setPaths([]); setLoading(true); setError('');
    void client.get(`${treeBase(workspace, selectedTree.name)}/paths`).then(rows => {
      if (active) {
        if (!Array.isArray(rows) || rows.some(path => typeof path !== 'string')) throw new Error('Unexpected tree paths response.');
        setPaths(rows);
        if (!store.get().scope) store.update(old => navigate(old, { mode: 'explorer', workspace, tree: selectedTree.name, treeType: selectedTree.type, path: '/' }));
      }
    }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, workspace, selectedTree, store, retry]);
  useEffect(() => { if (scope) { setWorkspace(scope.workspace); setTree(scope.tree); } }, [scope?.workspace, scope?.tree]);
  const treePaths = useMemo(() => {
    const all = new Set<string>(['/']);
    for (const path of paths) {
      const parts = normalizePath(path).split('/').filter(Boolean);
      parts.forEach((_, index) => all.add('/' + parts.slice(0, index + 1).join('/')));
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [paths]);
  function go(path: string) {
    if (!selectedTree) return;
    const next: Scope = { mode: 'explorer', workspace, tree, treeType: selectedTree.type, path };
    try { store.update(old => navigate(old, next)); } catch (e) { report(e); }
  }
  function chooseWorkspace(name: string) { setWorkspace(name); setTree(''); setFilter(''); setCollapsed(new Set()); update('m2'); }
  return <div className={`mm-container mm-${state.placement} ${state.menu === 'hidden' ? 'mm-hidden' : ''}`}>
    <nav className="mm-rail" aria-label="Main navigation">
      <button className="mm-brand" aria-label="Canvas main menu" title="Canvas" onClick={() => update(state.menu === 'm0' ? 'hidden' : 'm0')}><span /><span /><span /><span /></button>
      <span className="mm-rail-divider" />
      <button className={state.menu === 'm1' ? 'is-active' : ''} aria-label="Workspaces" title="Workspaces" onClick={() => update('m1')}><Grid2X2 size={19} /></button>
      <button className={state.menu === 'm2' ? 'is-active' : ''} aria-label="Current context" title="Current context" onClick={() => update('m2')}><FolderOpen size={19} /></button>
      <button aria-label="Agents" title="Agents · Ctrl+Alt+A" onClick={() => store.update(old => ({ ...old, toolbox: { ...old.toolbox, open: true, page: 'agents' } }))}><Bot size={19} /></button>
      <span className="mm-rail-spacer" />
      <button aria-label="Mounts" title="Mounts" onClick={services.mounts}><HardDrive size={18} /></button>
      <button aria-label="Desktop settings" title="Desktop settings" onClick={services.settings}><Settings2 size={18} /></button>
      <div className="mm-avatar" title={services.account}>{services.account.slice(0, 1).toUpperCase()}</div>
    </nav>
    <aside className="mm-panel" aria-label={state.menu === 'm0' ? 'Canvas menu' : state.menu === 'm1' ? 'Workspaces menu' : 'Context tree'}>
      <header><div><span className="mm-overline">YOUR SPACE TO THINK</span><h1>canvas<span>.</span></h1></div><button className="ds-icon-button" aria-label="Hide main menu" title="Hide main menu · Esc" onClick={() => update('hidden')}><PanelLeftClose size={17} /></button></header>
      {state.menu === 'm0' ? <div className="mm-page"><div className="mm-section-label">MAKE YOURSELF AT HOME</div><button className="mm-menu-item" onClick={() => update('m1')}><Grid2X2 size={17} /><span>Workspaces<small>Places for your projects</small></span><ChevronRight size={14} /></button><button className="mm-menu-item" onClick={() => { store.update(old => ({ ...old, toolbox: { ...old.toolbox, open: true, page: 'agents' } })); }}><Bot size={17} /><span>Agents<small>A little help, on demand</small></span><ChevronRight size={14} /></button><a className="mm-menu-item" href="/contexts"><Layers3 size={17} /><span>Contexts<small>Manage saved contexts</small></span><ArrowUpRight size={14} /></a><a className="mm-menu-item" href="/workspaces"><ArrowUpRight size={17} /><span>Open full web UI</span></a><button className="mm-menu-item" onClick={services.settings}><Settings2 size={17} /><span>Personalize desktop</span></button><button className="mm-menu-item" onClick={services.logout}><LogOut size={17} /><span>Log out</span></button></div> : state.menu === 'm1' ? <div className="mm-page"><div className="mm-section-label">WORKSPACES <span>{workspaces.length.toString().padStart(2, '0')}</span></div><p className="mm-description">Pick a place. Everything follows.</p>{workspaces.map((row, i) => <button key={row.name} className={`mm-workspace ${row.name === workspace ? 'is-active' : ''}`} onClick={() => chooseWorkspace(row.name)}><span className={`mm-workspace-symbol mm-symbol-${i % 3}`}><Grid2X2 size={18} /></span><span><strong>{row.label || row.name}</strong><small>{row.name}://</small></span><ChevronRight size={15} /></button>)}{!loading && !workspaces.length && !error && <p className="mm-description">No workspaces yet. <a href="/workspaces">Create one in the web UI.</a></p>}</div> : <>
        <div className="mm-workspace-heading"><button className="ds-icon-button" aria-label="Back to workspaces" onClick={() => update('m1')}><ArrowLeft size={15} /></button><strong>{workspaces.find(row => row.name === workspace)?.label || workspace || 'Your workspace'}</strong><span className="ds-live-dot" /></div>
        <div className="mm-tree-select"><label htmlFor="desktop-tree">BROWSE</label><select id="desktop-tree" aria-label="Workspace tree" value={tree} onChange={event => { setTree(event.target.value); setCollapsed(new Set()); }}>{trees.map(row => <option value={row.name} key={row.name}>{row.label || row.name}</option>)}</select></div>
        <label className="mm-search"><Search size={14} /><input aria-label="Find a path" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Find a path…" /><kbd>/</kbd></label>
        <nav className="mm-tree" aria-label="Virtual directory tree">{treePaths.filter(path => path.toLowerCase().includes(filter.toLowerCase()) && (filter || ![...collapsed].some(parent => path.startsWith(parent + '/')))).map(path => {
          const isCurrent = scope?.workspace === workspace && scope.tree === tree && scope.path === path;
          const depth = path.split('/').filter(Boolean).length;
          const hasChildren = path !== '/' && treePaths.some(other => other.startsWith(path + '/'));
          return <div className={`mm-tree-row ${isCurrent ? 'is-active' : ''}`} key={path} style={{ paddingLeft: Math.max(0, depth - 1) * 14 }}>
            {hasChildren ? <button className="mm-tree-chevron" aria-label={`${collapsed.has(path) ? 'Expand' : 'Collapse'} ${path}`} onClick={() => setCollapsed(old => { const next = new Set(old); if (next.has(path)) next.delete(path); else next.add(path); return next; })}>{collapsed.has(path) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</button> : <span className="mm-tree-chevron" />}
            <button className="mm-tree-path" aria-current={isCurrent ? 'page' : undefined} title={path} onClick={() => go(path)}>{isCurrent ? <FolderOpen size={15} /> : path === '/' ? <Layers3 size={15} /> : <Folder size={15} />}<span>{path === '/' ? 'All content' : path.split('/').at(-1)}</span>{isCurrent && <span className="mm-current-mark" />}</button>
          </div>;
        })}</nav>
      </>}
      {loading && <div className="mm-description" role="status">Loading your spaces…</div>}
      {error && <div className="ds-error" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>Retry</button>{workspace && <button onClick={() => { void client.workspaces.start(workspace).then(() => setRetry(value => value + 1)).catch(report); }}>Start workspace</button>}</div>}
      <footer><div className="mm-context-note"><Sparkles size={16} /><span>A place for everything.<br /><strong>Everything in its place.</strong></span></div><div className="mm-footer-line"><span title={scope && scopeUrl(scope)}>{scope?.workspace || 'canvas'}{scope ? '://' : ''}</span><kbd>ctrl alt ←</kbd></div></footer>
    </aside>
  </div>;
}
