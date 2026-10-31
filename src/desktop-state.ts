import type { ContentView } from '@web/components/common/content-views';
export type CanvasKind = 'content' | 'emails' | 'messages' | 'notes' | 'files' | 'tabs' | 'browser' | 'web' | 'terminal';
// `url` is a web page (browser tabs); `location` is a web UI route (web tabs).
export type Canvas = { id: string; kind: CanvasKind; title: string; url?: string; location?: string; view?: ContentView; documentLayout?: 'card' | 'table' | 'tile' };
export const kinds: CanvasKind[] = ['content', 'emails', 'messages', 'notes', 'files', 'tabs', 'browser', 'web', 'terminal'];
export function newCanvas(kind: CanvasKind): Canvas {
  return { id: crypto.randomUUID(), kind, title: kind === 'content' ? 'Content' : kind === 'web' ? 'Home' : kind[0].toUpperCase() + kind.slice(1) };
}
function treeBase(workspace: string, tree: string) {
  return `/workspaces/${encodeURIComponent(workspace)}/trees/${encodeURIComponent(tree)}`;
}
export function pathRoute(workspace: string, tree: string, path: string) {
  return `${treeBase(workspace, tree)}/path/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
}
