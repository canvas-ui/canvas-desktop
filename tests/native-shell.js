// Runs only in the feature-gated native smoke example.
window.addEventListener('DOMContentLoaded', () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async condition => { for (let i = 0; i < 160; i++) { if (await condition()) return; await sleep(100); } throw new Error('Native condition timed out: ' + String(condition)); };
  async function run() {
    await waitFor(() => window.__CANVAS_DESKTOP_UI__?.snapshot().scope);
    const ui = window.__CANVAS_DESKTOP_UI__;
    const incident = { mode: 'explorer', workspace: 'universe', tree: 'context', treeType: 'context', path: '/work/customer-foo/ops/snow-12345' };
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
      document.querySelector(i % 2 ? '[aria-label="Current context"]' : '[aria-label="Workspaces"]').click();
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
    // Move just before quitting: ExitRequested must flush without a JS debounce delay.
    expected[0] = { ...firstBounds, x: 495, y: 135, width: 790, height: 545 };
    await move(expected[0]);
    await invoke('desktop_test_result', { result: { ok: true, expected, maximized, windows: await windows(), menuClickToFrameMs: timings } });
  }
  run().catch(async error => invoke('desktop_test_result', { result: { ok: false, error: String(error), windows: await invoke('desktop_test_snapshot'), body: document.body.innerText } }));
});
