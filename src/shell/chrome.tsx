import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X, Copy } from 'lucide-react';
import { native } from './native';

// Every native surface is frameless: the component draws the title bar and
// the window manager still owns moving, resizing and maximizing through the
// window API. Nothing here applies in the browser preview.
const INTERACTIVE = 'button,a,input,select,textarea,[contenteditable],[data-no-drag]';
type ResizeDirection = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

export function useWindowChrome(report: (error: unknown) => void, options: { maximizable?: boolean } = {}) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!native) return;
    const win = getCurrentWindow();
    let disposed = false;
    const refresh = () => { void win.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(() => {}); };
    refresh();
    const unlisten = win.onResized(refresh);
    return () => { disposed = true; void unlisten.then(fn => fn()).catch(() => {}); };
  }, []);
  const maximizable = options.maximizable !== false;
  return {
    native,
    maximized,
    /** Pointer-down handler for a title bar: drag, or toggle maximize on a double click. */
    drag(event: ReactPointerEvent) {
      if (!native || event.button !== 0 || (event.target as Element).closest(INTERACTIVE)) return;
      event.preventDefault();
      const win = getCurrentWindow();
      if (event.detail === 2 && maximizable) void win.toggleMaximize().catch(report);
      else void win.startDragging().catch(report);
    },
    minimize: () => { if (native) void getCurrentWindow().minimize().catch(report); },
    toggleMaximize: () => { if (native && maximizable) void getCurrentWindow().toggleMaximize().catch(report); },
    close: () => { if (native) void getCurrentWindow().close().catch(report); },
    hide: () => { if (native) void getCurrentWindow().hide().catch(report); },
  };
}
export type WindowChrome = ReturnType<typeof useWindowChrome>;

export function WindowControls({ chrome, close = 'close' }: { chrome: WindowChrome; close?: 'close' | 'hide' | 'none' }) {
  if (!chrome.native) return null;
  return <div className="ds-window-controls" data-no-drag>
    <button className="ds-icon-button" aria-label="Minimize window" title="Minimize" onClick={chrome.minimize}><Minus size={14} /></button>
    <button className="ds-icon-button" aria-label={chrome.maximized ? 'Restore window' : 'Maximize window'} title={chrome.maximized ? 'Restore' : 'Maximize'} onClick={chrome.toggleMaximize}>{chrome.maximized ? <Copy size={12} /> : <Square size={12} />}</button>
    {close !== 'none' && <button className="ds-icon-button ds-window-close" aria-label={close === 'hide' ? 'Hide window' : 'Close window'} title={close === 'hide' ? 'Hide' : 'Close'} onClick={close === 'hide' ? chrome.hide : chrome.close}><X size={15} /></button>}
  </div>;
}

const EDGES: { direction: ResizeDirection; className: string }[] = [
  { direction: 'North', className: 'n' }, { direction: 'South', className: 's' }, { direction: 'East', className: 'e' }, { direction: 'West', className: 'w' },
  { direction: 'NorthEast', className: 'ne' }, { direction: 'NorthWest', className: 'nw' }, { direction: 'SouthEast', className: 'se' }, { direction: 'SouthWest', className: 'sw' },
];
/** Invisible resize handles along the window edges of a frameless window. */
export function ResizeEdges({ chrome }: { chrome: WindowChrome }) {
  if (!chrome.native || chrome.maximized) return null;
  return <>{EDGES.map(edge => <div key={edge.direction} className={`ds-edge ds-edge-${edge.className}`} aria-hidden onPointerDown={event => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startResizeDragging(edge.direction).catch(() => {});
  }} />)}</>;
}
