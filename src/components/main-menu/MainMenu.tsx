import { lazy, Suspense, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { pathRoute } from '../../desktop-state';
import { navigate, navigateLocation, openTab, scopeKey, routeScope, updateLayout, webCanvas } from '../../shell/model';
import type { DesktopServices } from '../../shell/integration';
import { ResizeEdges, WindowControls, useWindowChrome } from '../../shell/chrome';
import './main-menu.css';

const WebCanvas = lazy(() => import('../canvas-window/WebCanvas'));
export function MainMenu(services: DesktopServices) {
  const { store, state, scope, report } = services;
  const [location, setLocation] = useState('/workspaces');
  const chrome = useWindowChrome(report, { maximizable: false });
  const setLevel = (menu: typeof state.menu) => {
    try { store.update(old => ({ ...old, menu })); } catch (error) { report(error); }
  };
  const openToolbox = () => {
    try { store.update(old => ({ ...old, toolbox: { ...old.toolbox, open: true } })); } catch (error) { report(error); }
  };
  function go(next: string) {
    if (next === '/login') { services.logout(); return; }
    setLocation(next);
    const target = routeScope(next, tree => tree === scope?.tree ? scope.treeType : tree === 'context' ? 'context' : 'directory');
    try {
      store.update(old => {
        if (target) return navigateLocation(old, target, next);
        const ready = old.scope ? old : navigate(old, { mode: 'explorer', workspace: '', tree: 'context', treeType: 'context', path: '/' });
        return updateLayout(ready, scopeKey(ready.scope!), layout => openTab(layout, webCanvas(next)));
      });
    } catch (error) { report(error); }
  }
  return <div className={`mm-container ${state.menu === 'hidden' ? 'mm-hidden' : ''}`}>
    <ResizeEdges chrome={chrome} />
    <header className="mm-native-chrome" onPointerDown={chrome.drag}><span>canvas</span><button className="ds-icon-button" aria-label="Desktop settings" onClick={services.settings}><Settings2 size={16} /></button><WindowControls chrome={chrome} close="hide" /></header>
    <Suspense fallback={<p role="status">Opening navigation…</p>}><WebCanvas location={scope?.workspace ? pathRoute(scope.workspace, scope.tree, scope.path) : location} onNavigate={go} onBack={() => setLevel('m1')} open={entry => go(entry.location)} menu={{ level: state.menu, setLevel, toolbox: openToolbox }} /></Suspense>
  </div>;
}
