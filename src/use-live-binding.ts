import { useEffect } from 'react';
import { io } from 'socket.io-client';
import type { CanvasApiClient } from '@augmentd-labs/canvas-api-client';
import type { Remote } from './backend';
import { record, type Binding } from './desktop-state';

export function useLiveBinding(remote: Remote | undefined, client: CanvasApiClient | undefined, binding: Binding | undefined, onChange: (url?: string) => void) {
  const key = JSON.stringify(binding);
  useEffect(() => {
    if (!remote || !client || !binding) return;
    const token = remote.auth?.token || remote.device?.token;
    const socket = io(remote.url.replace(/\/$/, ''), { transports: ['websocket'], auth: { token }, reconnectionDelayMax: 30000 });
    const channel = binding.mode === 'context' ? `context:${binding.context}` : `workspace:${binding.workspace}`;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        if (binding!.mode === 'context') {
          const context = await client!.contexts.get(binding!.context);
          if (!disposed) onChange(context.url);
        } else if (!disposed) onChange();
      } catch { /* Existing panes retain their error/retry UI during outages. */ }
    }
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 150);
    };
    socket.on('connect', () => { socket.emit('subscribe', { channel }); schedule(); });
    socket.onAny((event: string, raw: unknown) => {
      if (!/^(context[.:]|document[.:]|tree[.:])/.test(event)) return;
      if (binding.mode === 'context') {
        const data = record(raw);
        const nested = record(data.context);
        const id = data.contextId || nested.id || (event.startsWith('context') ? data.id : undefined);
        if (id && id !== binding.context) return;
      }
      schedule();
    });
    return () => { disposed = true; clearTimeout(timer); socket.disconnect(); };
    // onChange reads no mutable layout state; rebind only with connection/scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, client, key]);
}
