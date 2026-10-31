// Runs only in the feature-gated native smoke example.
window.addEventListener('DOMContentLoaded', () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async condition => { for (let i = 0; i < 160; i++) { if (await condition()) return; await sleep(100); } throw new Error('Native condition timed out: ' + String(condition)); };
  async function run() {
    await waitFor(() => window.__CANVAS_DESKTOP_UI__);
    const ui = window.__CANVAS_DESKTOP_UI__;
    const incident = { mode: 'explorer', workspace: 'universe', tree: 'context', treeType: 'context', path: '/work/customer-foo/ops/snow-12345' };
    ui.dispatch({ type: 'set-tiling', automatic: false });
    if (!ui.snapshot().scope) ui.dispatch({ type: 'navigate', scope: { ...incident, path: '/' } });
    const windows = () => invoke('desktop_test_snapshot');
    const visibleCanvases = async () => (await windows()).filter(w => w.id.startsWith('canvas-') && w.visible);
    const equalBounds = (a, b) => a && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
    const verify = async (expected, message) => {
      const actual = await windows();
      for (const rect of expected) check(equalBounds(actual.find(w => w.id === rect.id && w.visible), rect), message + ': ' + JSON.stringify({ expected: rect, actual }));
    };
    const move = async rect => { await invoke('desktop_test_place', rect); await waitFor(async () => equalBounds((await windows()).find(w => w.id === rect.id), rect)); };
    if (window.__NATIVE_GEOMETRY_EXPECTED__) {
      const { windows: expected, maximized } = window.__NATIVE_GEOMETRY_EXPECTED__;
      await waitFor(async () => (await visibleCanvases()).length === 2 && (await windows()).some(w => w.id === 'toolbox' && w.width > 200));
      await sleep(300);
      if (maximized) {
        await waitFor(async () => (await windows()).some(w => w.id === maximized && w.maximized));
        await invoke('desktop_test_window_state', { id: maximized, action: 'unmaximize' });
        await waitFor(async () => equalBounds((await windows()).find(w => w.id === maximized), expected.find(w => w.id === maximized)));
      }
      await verify(expected, 'Exact placement must survive process restart');
      await invoke('desktop_test_result', { result: { ok: true, restarted: true, windows: await windows() } });
      return;
    }
    await waitFor(async () => (await visibleCanvases()).length === 1);
    ui.dispatch({ type: 'navigate', scope: incident });
    await waitFor(async () => (await visibleCanvases()).length === 1 && (await windows()).filter(w => w.id.startsWith('canvas-')).length === 2);
    const before = (await visibleCanvases())[0];
    check(before.width >= 320 && before.height >= 240, 'Canvas geometry is usable');
    const firstBounds = { id: before.id, x: 470, y: 110, width: 820, height: 560 };
    await move(firstBounds);
    ui.dispatch({ type: 'open-canvas', kind: 'notes' });
    await waitFor(async () => (await visibleCanvases()).length === 2);
    ui.dispatch({ type: 'open-canvas', kind: 'emails', asTab: true });
    await sleep(250);
    check((await visibleCanvases()).length === 2, 'A tab must reuse its window');
    await verify([firstBounds], 'Adding a window or tab must preserve manually placed canvases');
    ui.dispatch({ type: 'show-toolbox', mode: 'global' });
    await waitFor(async () => (await windows()).some(w => w.id === 'toolbox' && w.width > 200));
    await verify([firstBounds], 'Opening the toolbox must preserve canvas bounds');
    const second = (await visibleCanvases()).find(w => w.id !== before.id);
    const incidentKey = JSON.stringify([incident.workspace, incident.tree, incident.treeType, incident.path]);
    const pinnedFrame = ui.snapshot().layouts[incidentKey].frames[1];
    ui.dispatch({ type: 'pin-frame', frame: pinnedFrame.id, pinned: true });
    ui.dispatch({ type: 'navigate', scope: { ...incident, path: '/work/pinned-target' } });
    await waitFor(async () => (await visibleCanvases()).length === 1 && (await visibleCanvases())[0].id === second.id);
    await verify([second], 'Pinned navigation must reuse the native window and preserve its bounds');
    ui.dispatch({ type: 'navigate', scope: incident });
    await waitFor(async () => (await visibleCanvases()).length === 2);
    ui.dispatch({ type: 'pin-frame', frame: pinnedFrame.id, pinned: false });
    const expected = [firstBounds,
      { id: second.id, x: 1050, y: 220, width: 650, height: 590 },
      { id: 'main', x: 50, y: 90, width: 370, height: 820 },
      { id: 'toolbox', x: 1530, y: 60, width: 330, height: 650 },
    ];
    for (const rect of expected) await move(rect);
    // Both panel states retain their own bounds and ordinary menu changes do not resize.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(async () => (await windows()).some(w => w.id === 'toolbox' && w.width < 100));
    ui.dispatch({ type: 'show-menu' });
    ui.dispatch({ type: 'show-toolbox', mode: 'global' });
    await waitFor(async () => equalBounds((await windows()).find(w => w.id === 'toolbox'), expected[3]));
    await verify(expected, 'Expanding controls must restore their previous bounds');
    ui.dispatch({ type: 'navigate', scope: { ...incident, path: '/work/elsewhere' } });
    await waitFor(async () => (await visibleCanvases()).length === 1);
    check(ui.snapshot().toolbox.mode === 'global', 'Global tools must survive context changes');
    ui.dispatch({ type: 'navigate', scope: incident });
    await waitFor(async () => (await visibleCanvases()).length === 2);
    const restored = await visibleCanvases();
    check(restored.some(w => w.id === before.id), 'Window identity must survive a context round trip');
    await waitFor(async () => equalBounds((await windows()).find(w => w.id === 'toolbox'), expected[3]));
    await verify(expected, 'Context round trip must preserve exact bounds');
    // Test actual WebKit rendering latency of the local control state.
    const timings = [];
    for (let i = 0; i < 8; i++) timings.push(await new Promise(resolve => {
      const start = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey:true, altKey:true, code:i % 2 ? 'Digit2' : 'Digit1' }));
      requestAnimationFrame(() => resolve(performance.now() - start));
    }));
    await verify(expected, 'Menu navigation must not reset its size');
    let maximized;
    if (window.__NATIVE_SMOKE_WM__) {
      await invoke('desktop_test_window_state', { id: firstBounds.id, action: 'minimize' });
      await waitFor(async () => (await windows()).some(w => w.id === firstBounds.id && w.minimized));
      await sleep(500);
      await invoke('desktop_test_window_state', { id: firstBounds.id, action: 'unminimize' });
      await waitFor(async () => (await windows()).some(w => w.id === firstBounds.id && !w.minimized));
      await verify(expected, 'Minimizing must not replace normal bounds');
      maximized = second.id;
      await invoke('desktop_test_window_state', { id: maximized, action: 'maximize' });
      await waitFor(async () => (await windows()).some(w => w.id === maximized && w.maximized));
    }
    // A web page opens as a tab of the focused canvas: a page webview below the chrome of that window.
    const layoutKey = JSON.stringify([incident.workspace, incident.tree, incident.treeType, incident.path]);
    const pageWindows = async () => (await windows()).filter(w => (w.webviews || []).some(v => v.startsWith('url-')));
    ui.dispatch({ type: 'open-url', url: 'http://127.0.0.1:1430/__page' });
    await waitFor(async () => (await pageWindows()).length === 1);
    const pageWindow = (await pageWindows())[0];
    check(pageWindow.id.startsWith('canvas-') && pageWindow.visible && pageWindow.webviews.length === 2, 'The page webview joins a visible canvas window: ' + JSON.stringify(pageWindow));
    check(ui.snapshot().layouts[layoutKey].frames.some(f => f.tabs.some(t => t.kind === 'browser' && t.url === 'http://127.0.0.1:1430/__page')), 'The page is a browser tab of the layout');
    await sleep(400);
    await verify(expected, 'Opening a page tab must not move any window');
    const pageFrame = ui.snapshot().layouts[layoutKey].frames.find(f => f.tabs.some(t => t.kind === 'browser'));
    const browserTab = pageFrame.tabs.find(t => t.kind === 'browser');
    const pageId = pageWindow.webviews.find(id => id.startsWith('url-'));
    const marker = script => invoke('desktop_test_page_eval', { id: pageId, script });
    await marker('window.__canvasSentinel = 123456');
    const contentTab = pageFrame.tabs.find(t => t.kind !== 'browser');
    ui.dispatch({ type: 'activate-tab', frame: pageFrame.id, tab: contentTab.id });
    await sleep(400);
    check((await windows()).find(w => w.id === pageWindow.id).webviews.includes(pageId), 'Switching to content must keep website tabs alive');
    ui.dispatch({ type: 'activate-tab', frame: pageFrame.id, tab: browserTab.id });
    await sleep(400);
    check(Number(await marker('window.__canvasSentinel')) === 123456, 'Switching back must preserve page JavaScript state');
    // Call Rust directly so this tests its lock independently of the frontend queue.
    const raceTab = 'concurrent-open-fixture';
    await Promise.all(Array.from({length:12}, () => invoke('desktop_url_open', { window: pageWindow.id, tab: raceTab, url: 'http://127.0.0.1:1430/__page', chrome: 90 })));
    check((await windows()).find(w => w.id === pageWindow.id).webviews.length === 3, 'Concurrent opens must create exactly one webview');
    await invoke('desktop_test_url_close', { window: pageWindow.id, tab: raceTab });
    for (let i = 0; i < 4; i++) {
      await invoke('desktop_url_open', { window: pageWindow.id, tab: raceTab, url: 'http://127.0.0.1:1430/__page', chrome: 90 });
      await invoke('desktop_test_url_close', { window: pageWindow.id, tab: raceTab });
    }
    await invoke('desktop_url_show', { window: pageWindow.id, tab: browserTab.id, chrome: 90 });
    check(Number(await marker('window.__canvasSentinel')) === 123456, 'Opening and closing another page must preserve existing page state');
    ui.dispatch({ type: 'detach-tab', frame: pageFrame.id, tab: browserTab.id });
    await waitFor(async () => (await visibleCanvases()).length === 3 && (await pageWindows()).some(window => window.id !== pageWindow.id && window.webviews.includes(pageId)));
    check(Number(await marker('window.__canvasSentinel')) === 123456, 'Detaching must move the live page without reloading');
    const detachedFrame = ui.snapshot().layouts[layoutKey].frames.find(frame => frame.tabs.some(tab => tab.id === browserTab.id));
    ui.dispatch({ type: 'close-tab', frame: detachedFrame.id, tab: browserTab.id });
    await waitFor(async () => (await pageWindows()).length === 0);
    check((await windows()).some(w => w.id === pageWindow.id && w.visible), 'Closing the page tab keeps its canvas window');
    // Terminal sessions are owned by a context, not by its currently mounted app.
    ui.dispatch({ type: 'open-canvas', kind: 'terminal', asTab: true });
    await waitFor(async () => (await windows()).some(w => w.visible && w.title === 'Terminal — canvas'));
    const terminalWindow = (await windows()).find(w => w.visible && w.title === 'Terminal — canvas');
    const terminalEval = script => invoke('desktop_test_page_eval', { id: terminalWindow.id, script });
    await waitFor(async () => Number(await terminalEval(`Number(!!document.querySelector('[aria-label="Terminal app"] form'))`)) === 1);
    await terminalEval(`document.querySelector('[aria-label="Terminal app"] form').requestSubmit(); true`);
    const terminalScope = JSON.stringify([JSON.stringify(['http://127.0.0.1:1430','test']), JSON.stringify(['workspace', 'universe', 'context', 'context', incident.path])]);
    await waitFor(async () => (await invoke('terminal_list', { scope: terminalScope })).length === 1);
    const shell = (await invoke('terminal_list', { scope: terminalScope }))[0];
    await invoke('terminal_write', { id: shell.id, data: Array.from(new TextEncoder().encode("cd /tmp; export CANVAS_SESSION_TEST=preserved; printf 'READY_%s\\n' \"$CANVAS_SESSION_TEST\"\r")) });
    let terminalText = '';
    await waitFor(async () => { terminalText = new TextDecoder().decode(Uint8Array.from((await invoke('terminal_read', { id: shell.id, offset: 0 })).data)); return terminalText.includes('READY_preserved'); });
    ui.dispatch({ type: 'navigate', scope: { ...incident, path: '/work/autohub' } });
    await waitFor(async () => (await visibleCanvases()).length === 1);
    const otherScope = JSON.stringify([JSON.stringify(['http://127.0.0.1:1430','test']), JSON.stringify(['workspace', 'universe', 'context', 'context', '/work/autohub'])]);
    check((await invoke('terminal_list', { scope: otherScope })).length === 0, 'Different context must have its own terminal set');
    const otherShell = await invoke('terminal_create', { scope: otherScope, cwd: '/tmp' });
    ui.dispatch({ type: 'navigate', scope: incident });
    await waitFor(async () => (await visibleCanvases()).length === 2);
    check((await invoke('terminal_list', { scope: terminalScope }))[0].id === shell.id, 'Returning must reattach the same shell');
    await invoke('terminal_write', { id: shell.id, data: Array.from(new TextEncoder().encode("printf 'RETURN_%s_%s\\n' \"$CANVAS_SESSION_TEST\" \"$PWD\"\r")) });
    await waitFor(async () => new TextDecoder().decode(Uint8Array.from((await invoke('terminal_read', { id: shell.id, offset: 0 })).data)).includes('RETURN_preserved_/tmp'));
    await invoke('terminal_resize', { id: shell.id, cols: 110, rows: 35 });
    await invoke('terminal_close', { id: shell.id });
    await invoke('terminal_close', { id: otherShell.id });
    // Move just before quitting: ExitRequested must flush without a JS debounce delay.
    expected[0] = { ...firstBounds, x: 495, y: 135, width: 790, height: 545 };
    await move(expected[0]);
    await invoke('desktop_test_result', { result: { ok: true, expected, maximized, windows: await windows(), menuClickToFrameMs: timings, concurrentPageOpens: 12, pageStatePreserved: true, terminalContextSessions: true } });
  }
  run().catch(async error => {
    // Report through IPC; if IPC itself is broken, the fixture server logs the failure.
    try { await invoke('desktop_test_result', { result: { ok: false, error: String(error), windows: await invoke('desktop_test_snapshot'), body: document.body.innerText } }); }
    catch (ipcError) { await fetch('/__fixture', { method: 'POST', body: JSON.stringify({ error: String(error), ipcError: String(ipcError), body: document.body.innerText.slice(0, 2000) }) }).catch(() => {}); }
  });
});
