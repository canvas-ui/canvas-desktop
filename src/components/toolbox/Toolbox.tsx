import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ArrowUpRight, Bot, Check, ChevronDown, Clock3, Columns2, Command, Grid2X2, Layers3, Plus, Settings2, SlidersHorizontal, X } from 'lucide-react';
import { addCanvas, scopeKey, scopeUrl, updateLayout } from '../../shell/model';
import { canvasIcons, canvasNames } from '../canvas-window/CanvasWindow';
import type { CanvasKind } from '../../desktop-state';
import type { DesktopServices } from '../../shell/integration';
import './toolbox.css';

const kinds: CanvasKind[] = ['content', 'notes', 'files', 'emails', 'messages', 'tabs', 'browser'];
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  return <div className="tb-clock"><Clock3 size={16} /><strong>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong><span>{now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</span><small>Stays with you across contexts</small></div>;
}
function Agents({ client, report }: DesktopServices) {
  const [agents, setAgents] = useState<{ id: string; name?: string; status?: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [agent, setAgent] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    let active = true;
    void client.agents.list().then(rows => { if (active) { setAgents(rows); setAgent(rows[0]?.id || ''); } }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client]);
  async function send() {
    if (!agent || !prompt.trim()) return;
    setBusy(true); setSent(false);
    try { await client.agents.prompt(agent, { message: prompt.trim() }); setSent(true); setPrompt(''); }
    catch (e) { report(e); } finally { setBusy(false); }
  }
  return <div className="tb-agents"><div className="tb-label">A LITTLE EXTRA HELP</div>{loading ? <p role="status">Finding your agents…</p> : error ? <p role="alert">{error}</p> : !agents.length ? <p>No agents connected yet. <a href="/agents">Manage agents <ArrowUpRight size={12} /></a></p> : <form onSubmit={event => { event.preventDefault(); void send(); }}><label>Agent<select value={agent} onChange={event => setAgent(event.target.value)}>{agents.map(row => <option value={row.id} key={row.id}>{row.name || row.id}</option>)}</select></label><textarea aria-label="Agent task" placeholder="What would you like a hand with?" rows={4} value={prompt} onChange={event => { setPrompt(event.target.value); setSent(false); }} /><button className="tb-submit" disabled={busy || !prompt.trim()}>{busy ? 'Sending…' : 'Send task'}<ArrowUpRight size={14} /></button>{sent && <p role="status"><Check size={14} /> Task sent. <a href="/agents">View conversation</a></p>}</form>}</div>;
}
export function Toolbox(services: DesktopServices) {
  const { state, store, scope, layout, report } = services;
  const [asTab, setAsTab] = useState(false);
  const update = (patch: Partial<typeof state.toolbox>) => { try { store.update(old => ({ ...old, toolbox: { ...old.toolbox, ...patch } })); } catch (e) { report(e); } };
  function add(kind: CanvasKind) {
    if (!scope) return;
    try { store.update(old => updateLayout(old, scopeKey(scope), layout => addCanvas(layout, kind, asTab))); } catch (e) { report(e); }
  }
  return <div className={`tb-container ${state.toolbox.open ? 'is-open' : ''}`} onPointerDown={event => {
    if (services.native && event.button === 0 && event.target === event.currentTarget) void getCurrentWindow().startDragging().catch(report);
  }}>
    {state.toolbox.open && <section className="tb-panel" aria-label="Toolbox">
      <header title={services.native ? 'Drag to move toolbox' : undefined} onPointerDown={event => {
        if (services.native && event.button === 0 && !(event.target as Element).closest('button')) {
          event.preventDefault(); void getCurrentWindow().startDragging().catch(report);
        }
      }}><span className="tb-symbol"><SlidersHorizontal size={16} /></span><div><strong>Toolbox</strong><small>{state.toolbox.page === 'agents' ? 'Your on-demand team' : 'A little control. A lot of space.'}</small></div><button className="ds-icon-button" aria-label="Close toolbox" onClick={() => update({ open: false })}><X size={15} /></button></header>
      <div className="tb-modes" role="tablist" aria-label="Toolbox mode"><button role="tab" aria-selected={state.toolbox.mode === 'context'} onClick={() => update({ mode: 'context', page: 'tools' })}><Layers3 size={13} /> Context</button><button role="tab" aria-selected={state.toolbox.mode === 'global'} onClick={() => update({ mode: 'global', page: 'tools' })}><Command size={13} /> Global</button></div>
      {state.toolbox.page === 'agents' ? <Agents {...services} /> : state.toolbox.mode === 'global' ? <div className="tb-global"><Clock /><button className="tb-wide-action" onClick={() => update({ page: 'agents' })}><Bot size={16} /> Your agents <ArrowUpRight size={13} /></button><button className="tb-wide-action" onClick={services.settings}><Settings2 size={16} /> Desktop preferences <ArrowUpRight size={13} /></button></div> : <>
        <div className="tb-context-path"><span className="ds-live-dot" /><span>{scope ? scopeUrl(scope) : 'Choose a workspace'}</span></div>
        <div className="tb-section"><div className="tb-label">OPEN A CANVAS <label><input type="checkbox" checked={asTab} onChange={event => setAsTab(event.target.checked)} /> as tab</label></div><div className="tb-kind-grid">{kinds.map(kind => { const Icon = canvasIcons[kind]; return <button key={kind} disabled={!scope} onClick={() => add(kind)}><Icon size={18} strokeWidth={1.5} /><span>{canvasNames[kind]}</span><Plus size={11} /></button>; })}</div></div>
        <div className="tb-section"><div className="tb-label">ARRANGE YOUR SPACE <span>{layout?.frames.length || 0} windows</span></div><div className="tb-arrangements">{([{ id: 'columns', icon: Columns2, name: 'Columns' }, { id: 'grid', icon: Grid2X2, name: 'Grid' }, { id: 'focus', icon: Layers3, name: 'Focus' }] as const).map(({ id, icon: Icon, name }) => <button key={id} aria-pressed={layout?.arrangement === id} disabled={!scope} onClick={() => { if (scope) { store.update(old => updateLayout(old, scopeKey(scope), layout => ({ ...layout, arrangement: id }))); if (layout?.arrangement === id) services.tile(); } }}><Icon size={17} /><span>{name}</span></button>)}</div></div>
        <button className="tb-wide-action tb-agent-action" onClick={() => update({ page: 'agents' })}><Bot size={16} /><span>Ask an agent</span><kbd>ctrl alt A</kbd></button>
      </>}
      <footer><span className="ds-live-dot" />{state.toolbox.mode === 'context' ? 'Follows your context' : 'Always within reach'}<ChevronDown size={12} /></footer>
    </section>}
    <div className="tb-launcher-row"><span className="tb-launcher-hint">{state.toolbox.open ? 'Less chrome. More canvas.' : 'Your tools, one tap away.'}</span><button className="tb-launcher" aria-label={state.toolbox.open ? 'Hide toolbox' : 'Open toolbox'} title="Toolbox · Ctrl+Alt+Space" aria-expanded={state.toolbox.open} onClick={() => update({ open: !state.toolbox.open })}>{state.toolbox.open ? <X size={18} /> : <span className="tb-dot" />}</button></div>
  </div>;
}
