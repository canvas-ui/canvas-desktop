import { useSyncExternalStore } from 'react';
import { initialState, parseState, type DesktopState } from './model.ts';

// The server namespace is supplied by web-session. Account IDs isolate layouts
// between people who sign into the same server on this device.
export function createDesktopStore(account: string) {
  const key = `desktop.shell.v2:${account}`;
  let state = initialState();
  let error = '';
  const listeners = new Set<() => void>();
  function read() {
    try {
      const raw = localStorage.getItem(key);
      const restored = parseState(raw);
      const serialized = JSON.stringify(restored);
      if (raw !== null && serialized !== raw) localStorage.setItem(key, serialized);
      state = restored;
      error = '';
    }
    catch (e) { error = String(e); }
  }
  read();
  const onStorage = (event: StorageEvent) => {
    // Native storage events expose the underlying, server-prefixed key.
    if (event.key === null || event.key.endsWith(`:${key}`) || event.key === key) {
      read(); listeners.forEach(listener => listener());
    }
  };
  return {
    get: () => state,
    error: () => error,
    subscribe: (listener: () => void) => {
      if (!listeners.size) window.addEventListener('storage', onStorage);
      listeners.add(listener);
      return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', onStorage); };
    },
    update: (update: (state: DesktopState) => DesktopState) => {
      // Re-read before modifying to merge updates from independent webviews.
      read();
      if (error) throw new Error(error);
      const updated = update(state);
      if (updated === state) return;
      const next = parseState(JSON.stringify(updated));
      localStorage.setItem(key, JSON.stringify(next));
      state = next; listeners.forEach(listener => listener());
    },
    dispose: () => window.removeEventListener('storage', onStorage),
  };
}
export type DesktopStore = ReturnType<typeof createDesktopStore>;
export const useDesktopState = (store: DesktopStore) => useSyncExternalStore(store.subscribe, store.get);
