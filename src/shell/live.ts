import { emit } from '@tauri-apps/api/event';
import { native } from './native';
import { scopeKey, type Scope } from './model';

// One lazily loaded socket in the menu host, not one socket per canvas/tab.
export function watchContext(url: string, scope: Scope) {
  let disposed = false;
  let disconnect: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  void import('socket.io-client').then(({ io }) => {
    if (disposed) return;
    const socket = io(url, { transports: ['websocket'], auth: { token: localStorage.getItem('authToken') }, reconnectionDelayMax: 30000 });
    const key = scopeKey(scope);
    let connected = false;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (native) void emit('desktop:content-changed', key).catch(() => {});
        else window.dispatchEvent(new CustomEvent('desktop:content-changed', { detail: key }));
      }, 150);
    };
    socket.on('connect', () => { socket.emit('subscribe', { channel: `workspace:${scope.workspace}` }); if (connected) schedule(); connected = true; });
    socket.onAny(event => { if (/^(document[.:]|tree[.:])/.test(event)) schedule(); });
    disconnect = () => socket.disconnect();
  }).catch(() => { /* Manual refresh remains available when sockets are unavailable. */ });
  return () => { disposed = true; clearTimeout(timer); disconnect?.(); };
}
