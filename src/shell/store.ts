import { useSyncExternalStore } from 'react';
import { initialState, parseState, validateState } from './model.ts';
import { desktopAction, desktopCommand, type DesktopAction, type DesktopCommand } from './actions.ts';

export type StoreMessage = { type: 'command'; command: DesktopCommand } | { type: 'request' } | { type: 'snapshot'; epoch: string; revision: number; raw: string; accepted?: string[]; error?: string };
export type StoreChannel = { owner: boolean; receive: (listener: (message: StoreMessage) => void) => () => void; send: (message: StoreMessage) => Promise<void>; report: (error: unknown) => void };

/** Preserve unchanged subtrees when the authoritative snapshot changes. */
function share<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object' || Array.isArray(previous) !== Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let equal = keys.length === Object.keys(before).length;
  for (const key of keys) {
    after[key] = share(before[key], after[key]);
    if (!Object.prototype.hasOwnProperty.call(before, key) || after[key] !== before[key]) equal = false;
  }
  return equal ? previous : next;
}

// The server namespace is supplied by web-session. Account IDs isolate layouts
// between people who sign into the same server on this device.
export function createDesktopStore(account: string, channel?: StoreChannel) {
  const key = `desktop.shell.v2:${account}`;
  const storage = localStorage;
  let state = initialState();
  let serialized: string | null | undefined;
  let error = '';
  const listeners = new Set<() => void>();
  function read() {
    try {
      const raw = storage.getItem(key);
      if (raw === serialized) { error = ''; return; }
      const restored = parseState(raw);
      const normalized = JSON.stringify(restored);
      if (raw !== null && normalized !== raw && (!channel || channel.owner)) storage.setItem(key, normalized);
      serialized = raw === null ? null : normalized;
      state = share(state, restored);
      error = '';
    }
    catch (e) { error = String(e); }
  }
  read();
  let authoritative = state;
  let epoch: string = crypto.randomUUID();
  let revision = 0;
  const pending = new Map<string, DesktopCommand>();
  const notify = () => listeners.forEach(listener => listener());
  const send = (message: StoreMessage) => { void channel?.send(message).catch(error => channel.report(error)); };
  const accepted = new Set<string>();
  const publish = (error?: string) => send({ type: 'snapshot', epoch, revision, raw: serialized || JSON.stringify(state), accepted: [...accepted], error });
  const rebase = () => {
    if (!pending.size && state === authoritative) return;
    const previous = state;
    let next = authoritative;
    for (const command of pending.values()) next = desktopAction(next, command);
    if (pending.size) next = validateState(next);
    state = share(state, next);
    if (!pending.size) authoritative = state;
    if (state !== previous) notify();
  };
  const commit = (command: DesktopCommand) => {
    if (error) throw new Error(error);
    const next = validateState(desktopAction(state, command));
    if (next === state) return false;
    const raw = JSON.stringify(next);
    if (raw === serialized) return false;
    storage.setItem(key, raw);
    serialized = raw;
    state = next;
    authoritative = next;
    revision++;
    notify();
    return true;
  };
  let disconnect: (() => void) | undefined;
  const connect = () => {
    if (!channel || disconnect) return;
    disconnect = channel?.receive(message => {
      if (channel.owner) {
        if (message.type === 'request') publish();
        if (message.type === 'command') {
          if (accepted.has(message.command.id)) { publish(); return; }
          accepted.add(message.command.id);
          if (accepted.size > 256) accepted.delete(accepted.values().next().value!);
          try { commit(message.command); publish(); }
          catch (error) { publish(String(error)); }
        }
      } else if (message.type === 'snapshot') {
        for (const id of message.accepted || []) pending.delete(id);
        if (message.epoch !== epoch || message.revision >= revision) {
          if (message.raw !== serialized) authoritative = parseState(message.raw);
          epoch = message.epoch; revision = message.revision;
          serialized = message.raw;
        }
        try { rebase(); } catch (error) { channel.report(error); }
        if (message.error) channel.report(message.error);
      }
    });
    if (channel.owner) publish();
    else send({ type: 'request' });
  };
  const onStorage = (event: StorageEvent) => {
    // Native storage events expose the underlying, server-prefixed key.
    if (event.key === null || event.key.endsWith(`:${key}`) || event.key === key) {
      const previous = state;
      read();
      if (state !== previous) listeners.forEach(listener => listener());
    }
  };
  return {
    get: () => state,
    error: () => error,
    subscribe: (listener: () => void) => {
      if (!listeners.size && !channel) window.addEventListener('storage', onStorage);
      listeners.add(listener);
      connect();
      return () => { listeners.delete(listener); if (!listeners.size) { disconnect?.(); disconnect = undefined; window.removeEventListener('storage', onStorage); } };
    },
    dispatch: (action: DesktopAction) => {
      connect();
      const command = desktopCommand(action);
      if (error) throw new Error(error);
      if (channel && !channel.owner) {
        const next = validateState(desktopAction(state, command));
        pending.set(command.id, command);
        if (next !== state) { state = next; notify(); }
        void channel.send({ type: 'command', command }).catch(error => {
          pending.delete(command.id); rebase(); channel.report(error);
        });
      } else {
        if (!channel) read();
        if (error) throw new Error(error);
        const changed = commit(command);
        if (channel && changed) publish();
      }
    },
    dispose: () => { disconnect?.(); disconnect = undefined; window.removeEventListener('storage', onStorage); },
  };
}
export type DesktopStore = ReturnType<typeof createDesktopStore>;
export const useDesktopState = (store: DesktopStore) => useSyncExternalStore(store.subscribe, store.get);
