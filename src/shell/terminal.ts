import { createCommandQueue } from './command-queue';
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TerminalTransport, TerminalSession, TerminalRead } from '@web/components/terminal/terminal-transport';
export function createTerminalTransport(namespace: string | (() => Promise<string>)): TerminalTransport {
  const enqueue = createCommandQueue();
  const key = async (scope: string) => JSON.stringify([typeof namespace === 'string' ? namespace : await namespace(), scope]);
  return {
    list: async scope => invoke<TerminalSession[]>('terminal_list', { scope: await key(scope) }),
    create: async (scope, cwd) => invoke<TerminalSession>('terminal_create', { scope: await key(scope), cwd: cwd || null }),
    attach: async (id, onOutput) => {
      const channel = new Channel<TerminalRead>();
      channel.onmessage = onOutput;
      const subscription = await invoke<number>('terminal_subscribe', { id, channel });
      return () => { channel.onmessage = () => {}; void invoke('terminal_unsubscribe', { id, subscription }).catch(() => {}); };
    },
    watch: async (scope, onChange) => {
      const scoped = await key(scope);
      return listen<string>('terminal:sessions', ({ payload }) => { if (payload === scoped) onChange(); });
    },
    write: (id, data) => enqueue(id, async () => { const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data; for (let start = 0; start < bytes.length; start += 65536) await invoke('terminal_write', { id, data: Array.from(bytes.subarray(start, start + 65536)) }); }),
    resize: (id, cols, rows) => invoke('terminal_resize', { id, cols, rows }),
    close: id => invoke('terminal_close', { id }),
  };
}
