import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { StoreChannel, StoreMessage } from './store';

/** Native windows send commands to the menu host; only that host persists layouts. */
export function createStoreChannel(namespace: string, owner: boolean): StoreChannel {
  let handler: (message: StoreMessage) => void = () => {};
  let ready: ReturnType<typeof listen> | undefined;
  return {
    owner,
    receive: listener => {
      handler = listener;
      ready = listen<{ namespace: string; message: StoreMessage }>('desktop:store', ({ payload }) => {
        if (payload.namespace === namespace) handler(payload.message);
      }, { target: getCurrentWindow().label });
      const registered = ready;
      return () => { handler = () => {}; void registered.then(unlisten => unlisten()); };
    },
    send: async message => {
      await ready;
      const payload = { namespace, message };
      if (owner) await emit('desktop:store', payload);
      else await emitTo('main', 'desktop:store', payload);
    },
    report: error => { void emitTo(getCurrentWindow().label, 'desktop:error', String(error)); },
  };
}
