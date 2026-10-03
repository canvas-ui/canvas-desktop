export type Metadata = Record<string, unknown>;
export type CanvasKind = 'content' | 'emails' | 'messages' | 'notes' | 'files' | 'tabs' | 'browser';
export type Canvas = { id: string; kind: CanvasKind; title: string; width: number; height: number; url?: string; query?: string };
export type Arrangement = { version: 1; canvases: Canvas[] };
export const kinds: CanvasKind[] = ['content', 'emails', 'messages', 'notes', 'files', 'tabs', 'browser'];
export function newCanvas(kind: CanvasKind): Canvas {
  return { id: crypto.randomUUID(), kind, title: kind === 'content' ? 'Content' : kind[0].toUpperCase() + kind.slice(1), width: 1, height: 360 };
}
export function record(value: unknown): Metadata {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Metadata : {};
}
// Absence means the default; an explicit empty list is a saved empty desktop.
// Reject unsupported/malformed layouts instead of silently overwriting them.
export function readArrangement(metadata: unknown): Arrangement {
  const raw = record(record(metadata).ui).desktop;
  if (raw === undefined) return { version: 1, canvases: [{ id: 'default-content', kind: 'content', title: 'Content', width: 1, height: 360 }] };
  const layout = record(raw);
  if (layout.version !== 1 || !Array.isArray(layout.canvases)) throw new Error('Unsupported desktop layout. Saved metadata was left untouched.');
  const ids = new Set<string>();
  for (const value of layout.canvases) {
    const c = record(value);
    if (typeof c.id !== 'string' || !c.id || ids.has(c.id) || !kinds.includes(c.kind as CanvasKind)
      || typeof c.title !== 'string' || ![1, 2, 3].includes(c.width as number)
      || typeof c.height !== 'number' || !Number.isFinite(c.height) || c.height < 200 || c.height > 1200
      || (c.url !== undefined && typeof c.url !== 'string') || (c.query !== undefined && typeof c.query !== 'string')) {
      throw new Error('Invalid desktop layout. Saved metadata was left untouched.');
    }
    ids.add(c.id);
  }
  return structuredClone(layout) as Arrangement;
}
export function withArrangement(metadata: unknown, desktop: Arrangement): Metadata {
  const current = record(metadata);
  return { ...current, ui: { ...record(current.ui), desktop } };
}
export function treeBase(workspace: string, tree: string) {
  return `/workspaces/${encodeURIComponent(workspace)}/trees/${encodeURIComponent(tree)}`;
}
export function pathRoute(workspace: string, tree: string, path: string) {
  return `${treeBase(workspace, tree)}/path/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
}
export type Binding = { mode: 'explorer'; workspace: string; tree: string; treeType: string; path: string } | { mode: 'context'; context: string };
export function documentRoute(binding: Binding, canvas: Canvas, offset = 0): string {
  const params = new URLSearchParams({ limit: '50', offset: String(offset) });
  if (binding.mode === 'explorer') {
    params.set('context', binding.path);
    params.set('treeNameOrTreeId', binding.tree);
    params.set('treeType', binding.treeType);
  }
  if (canvas.query) params.append('q', canvas.query);
  const schemas: Partial<Record<CanvasKind, string>> = { emails: 'data/schema/message/email', messages: 'data/schema/message', notes: 'data/schema/note', files: 'data/schema/file', tabs: 'data/schema/tab' };
  if (schemas[canvas.kind]) params.append('allOf', schemas[canvas.kind]!);
  return `${binding.mode === 'context' ? `/contexts/${encodeURIComponent(binding.context)}` : `/workspaces/${encodeURIComponent(binding.workspace)}`}/documents?${params}`;
}
