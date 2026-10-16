import { useCallback, useMemo, type ReactNode } from 'react';
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
import { documentLocation, webTitle } from '../../shell/model';
import '../../web-host.css';

// The web UI's pages, rendered inside one canvas tab. This is the webui's own
// "URL inside a canvas" trick (components/shell/strip/CanvasRouter): the three
// router contexts are supplied by hand, so every page keeps using useLocation,
// useNavigate and <Link> unchanged while this tab owns the address. Opening
// "to the side" from any page becomes a desktop tab (or a frame on shift).
export type WebOpen = (entry: { location: string; title: string }, side: boolean) => void;

function toPath(to: To): string { return createPath(typeof to === 'string' ? parsePath(to) : to); }
function Shift({ children }: { children: ReactNode }) { return <>{children}</>; }

export default function WebCanvas({ location, onNavigate, onBack, open }: { location: string; onNavigate: (next: string) => void; onBack: (steps: number) => void; open: WebOpen }) {
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
  return <div className={`cw-web ${bare ? 'is-bare' : ''} ${fullBleed ? 'is-full-bleed' : ''}`} onPointerDownCapture={event => { (window as unknown as { __canvasShift?: boolean }).__canvasShift = event.shiftKey; }} onKeyDownCapture={event => { (window as unknown as { __canvasShift?: boolean }).__canvasShift = event.shiftKey; }}>
    <ThemeProvider><ToastContainer><NotificationsProvider><CanvasPinsProvider>
      <NavigationContext.Provider value={navigation}>
        <LocationContext.Provider value={{ location: loc, navigationType: NavigationType.Push }}>
          <RouteContext.Provider value={{ outlet: null, matches: [], isDataRoute: false }}>
            <MenuProvider><AgentSessionProvider><ToolboxProvider><LensFeedProvider>
              <SideViewContext.Provider value={sideView}><CanvasRowContext.Provider value={row}><DocumentModalProvider>
                <Shift><Routes>{shellRoutes}</Routes></Shift>
              </DocumentModalProvider></CanvasRowContext.Provider></SideViewContext.Provider>
            </LensFeedProvider></ToolboxProvider></AgentSessionProvider></MenuProvider>
          </RouteContext.Provider>
        </LocationContext.Provider>
      </NavigationContext.Provider>
    </CanvasPinsProvider></NotificationsProvider></ToastContainer></ThemeProvider>
  </div>;
}
