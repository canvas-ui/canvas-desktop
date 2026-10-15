# Desktop components

Each component folder owns its React view and CSS. Import only the shared
`DesktopServices` contract from `shell/integration.ts`, pure operations from
`shell/model.ts`, and the shared content primitives you actually need.

`MainMenu` renders M0/M1/M2 in either a left or top placement. It loads workspace
navigation but does not create native windows. `CanvasWindow` owns tabs and
contextual content rendering. `Toolbox` owns global/context applets and dispatches
layout operations. `Settings` modifies presentation preferences. `shell/Desktop`
selects the surface, owns authentication, live events, shortcuts and the store;
`shell/native` reconciles native windows separately from local interaction state.

To add a widget, give it a folder, export a component accepting `DesktopServices`,
and add its descriptor to `desktopWidgets` in `shell/Desktop.tsx`. Mount it in the
appropriate host surface. Native surface creation belongs in the Rust host;
widgets should remain usable without Tauri so a later phone host can reuse them.
The descriptor list is an extension catalog, not a dynamic plugin loader.

Use `store.update(previous => next)` with the pure model operations. Never mutate
snapshots, save credentials in layouts, or use an arbitrary display label as a
path identity. `scopeKey()` deliberately separates workspace, tree, tree type,
and path. Storage failures are surfaced instead of replacing saved layouts.

Use `--ds-*` semantic tokens. Namespace selectors (`mm-`, `cw-`, `tb-`) to keep
component styles independent. Avoid layout animations on input-critical paths;
respect reduced motion and preserve accessible labels for UI automation.

The versioned `window.__CANVAS_DESKTOP_UI__` action API can be used by browser
automation or a future MCP adapter. It supports navigation, canvas creation,
tab closing, and revealing controls, with the same local operations as the UI.
It intentionally does not provide arbitrary JS execution or a network listener.
