import { ContentWindowContext } from '@web/components/common/content-window-context';
import { memo, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  NavigationType, Routes, createPath, parsePath,
  UNSAFE_LocationContext as LocationContext, UNSAFE_NavigationContext as NavigationContext, UNSAFE_RouteContext as RouteContext,
  type Location, type To,
} from 'react-router-dom';
import { shellRoutes } from '@web/routes/shell-routes';
import { ThemeProvider } from '@web/theme';
import { ToastContainer } from '@web/components/ui/toast-container';
import { NotificationsProvider } from '@web/components/notifications/notifications-context';
import { CanvasPinsProvider } from '@web/components/home/pins-context';
import { MenuProvider } from '@web/components/shell/menu-context';
import { AgentSessionProvider } from '@web/components/agent/agent-session-context';
import { ToolboxProvider } from '@web/components/toolbox/toolbox-context';
import { LensFeedProvider } from '@web/components/toolbox/lens-feed-context';
import { DocumentModalProvider } from '@web/components/shell/document-modal-context';
import { SideViewContext, type SideViewContextValue } from '@web/components/shell/use-side-view';
import { CanvasRowContext, MAIN_COLUMN, type CanvasEntrySpec, type CanvasRowValue } from '@web/components/shell/strip/use-canvas-row';
import { isBare, isFullBleed } from '@web/components/shell/route-chrome';
import { getDocumentDisplayInfo } from '@web/lib/document-display';
import type { Document } from '@web/types/workspace';
import { MenuBar } from '@web/components/shell/MenuBar';
import { M2Content } from '@web/components/shell/MenuPanelArea';
import { useMenu } from '@web/components/shell/use-menu';
import { WorkspaceList } from '@web/components/menu/workspaces/WorkspaceList';
import { ContextList } from '@web/components/menu/contexts/ContextList';
import { AgentList } from '@web/components/menu/agents/AgentList';
import { AdminMenu } from '@web/components/menu/admin/AdminMenu';
import { SettingsMenu } from '@web/components/menu/settings/SettingsMenu';
import { AppsMenu } from '@web/components/menu/apps/AppsMenu';
import { ToolboxPanel } from '@web/components/toolbox/ToolboxPanel';
import { AddPanel } from '@web/components/toolbox/AddPanel';
import { useToolbox } from '@web/components/toolbox/use-toolbox';
import type { CanvasKind } from '../../desktop-state';
import type { DesktopState } from '../../shell/model';
import { documentLocation, webTitle } from '../../shell/model';
import '../../web-host.css';

// The web UI's pages, rendered inside one canvas tab. This is the webui's own
// "URL inside a canvas" trick (components/shell/strip/CanvasRouter): the three
// router contexts are supplied by hand, so every page keeps using useLocation,
// useNavigate and <Link> unchanged while this tab owns the address. Opening
// "to the side" from any page becomes a desktop tab (or a frame on shift).
export type WebOpen = (entry: { location: string; title: string }, side: boolean) => void;

function toPath(to: To): string { return createPath(typeof to === 'string' ? parsePath(to) : to); }
type MenuOptions = { level: DesktopState['menu']; setLevel: (level: DesktopState['menu']) => void; toolbox: () => void };
function WebMenu({ level, setLevel, toolbox }: MenuOptions) {
  const { state, dispatch } = useMenu();
  const { state: tools, closeT1 } = useToolbox();
  const applied = useRef(level);
  const pending = useRef(false);
  useEffect(() => {
    if (level !== applied.current) {
      applied.current = level;
      pending.current = true;
      dispatch({ type: 'RESTORE_MENU', menu: { ...state, m0Open: true, m1Open: level === 'm1', m2Open: level === 'm2', m2View: level === 'm2' ? 'detail' : null, activeSection: state.activeSection || 'workspaces' } });
    }
  }, [level, state, dispatch]);
  useEffect(() => {
    const next = state.m2Open ? 'm2' : state.m1Open ? 'm1' : 'm0';
    if (pending.current) { if (next === level || level === 'hidden') pending.current = false; return; }
    if (level !== 'hidden' && next !== applied.current) { applied.current = next; setLevel(next); }
  }, [level, state.m1Open, state.m2Open]);
  useEffect(() => { if (tools.t1Open) { closeT1(); toolbox(); } }, [tools.t1Open, closeT1, toolbox]);
  const section = state.activeSection;
  return <div className="desktop-navigation"><MenuBar />{level !== 'hidden' && level !== 'm0' && <div className="desktop-navigation-panel">{level === 'm2' ? <M2Content /> : section === 'contexts' ? <ContextList /> : section === 'agents' ? <AgentList /> : section === 'admin' ? <AdminMenu /> : section === 'settings' ? <SettingsMenu /> : section === 'apps' ? <AppsMenu /> : <WorkspaceList />}</div>}</div>;
}

export default memo(function WebCanvas({ location, onNavigate, onBack, open, menu, kind, windowView }: { location: string; onNavigate: (next: string) => void; onBack: (steps: number) => void; open: WebOpen; menu?: MenuOptions; kind?: CanvasKind; windowView?: React.ContextType<typeof ContentWindowContext> }) {
  const container = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setCompact(entries[0].contentRect.width < 720));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const hostedView = useMemo(() => {
    const schemas: Partial<Record<CanvasKind, string>> = { emails: 'data/schema/message/email', messages: 'data/schema/message', notes: 'data/schema/note', files: 'data/schema/file', tabs: 'data/schema/tab' };
    return windowView ? { ...windowView, compact, schema: kind ? schemas[kind] : undefined } : null;
  }, [windowView, compact, kind]);
  const loc = useMemo<Location>(() => {
    const p = parsePath(location);
    return { pathname: p.pathname || '/', search: p.search || '', hash: p.hash || '', state: null, key: location };
  }, [location]);
  const navigation = useMemo(() => ({
    basename: '/', static: false, useTransitions: undefined, future: {},
    navigator: { createHref: toPath, go: (delta: number) => onBack(delta), push: (to: To) => onNavigate(toPath(to)), replace: (to: To) => onNavigate(toPath(to)) },
  }), [onNavigate, onBack]);
  // Shift decides tab versus frame; the pages only know "open to the side".
  const shift = useCallback(() => !!(window as unknown as { __canvasShift?: boolean }).__canvasShift, []);
  const openDocument = useCallback((document: Document, workspaceId: string) => open({ location: documentLocation(workspaceId, document.id), title: getDocumentDisplayInfo(document).title }, shift()), [open, shift]);
  const sideView = useMemo<SideViewContextValue>(() => ({ entry: null, open: openDocument, preview: openDocument, close: () => {} }), [openDocument]);
  const row = useMemo<CanvasRowValue>(() => ({
    rows: [{ key: 'desk', label: 'Desk', main: location, mainExpanded: false, entries: [] }], activeRow: 0, focus: MAIN_COLUMN, setFocus: () => {},
    openCanvas: (entry: CanvasEntrySpec) => entry.kind === 'route' ? open({ location: entry.location, title: webTitle(entry.location) }, shift()) : openDocument(entry.document, entry.workspaceId),
    openDocument, closeCanvas: () => {}, navigateCanvas: () => {}, toggleExpanded: () => {}, activateRow: (_key, _label, main) => onNavigate(main), moveRow: () => {}, closeRow: () => {},
  }), [location, open, openDocument, onNavigate, shift]);
  const bare = isBare(loc.pathname), fullBleed = isFullBleed(loc.pathname);
  return <div ref={container} className={`cw-web ${bare ? 'is-bare' : ''} ${fullBleed ? 'is-full-bleed' : ''}`} onPointerDownCapture={event => { (window as unknown as { __canvasShift?: boolean }).__canvasShift = event.shiftKey; }} onKeyDownCapture={event => { (window as unknown as { __canvasShift?: boolean }).__canvasShift = event.shiftKey; }}>
    <ContentWindowContext.Provider value={hostedView}><ThemeProvider><ToastContainer><NotificationsProvider><CanvasPinsProvider>
      <NavigationContext.Provider value={navigation}>
        <LocationContext.Provider value={{ location: loc, navigationType: NavigationType.Push }}>
          <RouteContext.Provider value={{ outlet: null, matches: [], isDataRoute: false }}>
            <MenuProvider><AgentSessionProvider><ToolboxProvider><LensFeedProvider>
              <SideViewContext.Provider value={sideView}><CanvasRowContext.Provider value={row}><DocumentModalProvider>
                {menu ? <WebMenu {...menu} /> : <div className="flex h-full min-w-0 overflow-hidden"><div className="flex-1 min-w-0 overflow-auto"><Routes>{shellRoutes}</Routes></div><AddPanel /><ToolboxPanel /></div>}
              </DocumentModalProvider></CanvasRowContext.Provider></SideViewContext.Provider>
            </LensFeedProvider></ToolboxProvider></AgentSessionProvider></MenuProvider>
          </RouteContext.Provider>
        </LocationContext.Provider>
      </NavigationContext.Provider>
    </CanvasPinsProvider></NotificationsProvider></ToastContainer></ThemeProvider></ContentWindowContext.Provider>
  </div>;
});
