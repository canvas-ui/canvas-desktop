import { createCommandQueue } from './command-queue';
import { invoke } from '@tauri-apps/api/core';
import type { TerminalTransport, TerminalSession, TerminalRead } from '@web/components/terminal/terminal-transport';
export function createTerminalTransport(namespace: string | (() => Promise<string>)): TerminalTransport {
  const enqueue = createCommandQueue();
  const key = async (scope: string) => JSON.stringify([typeof namespace === 'string' ? namespace : await namespace(), scope]);
  return {
    list: async scope => invoke<TerminalSession[]>('terminal_list', { scope: await key(scope) }),
    create: async (scope, cwd) => invoke<TerminalSession>('terminal_create', { scope: await key(scope), cwd: cwd || null }),
    read: (id, offset) => invoke<TerminalRead>('terminal_read', { id, offset }),
    write: (id, data) => enqueue(id, async () => { const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data; for (let start = 0; start < bytes.length; start += 65536) await invoke('terminal_write', { id, data: Array.from(bytes.subarray(start, start + 65536)) }); }),
    resize: (id, cols, rows) => invoke('terminal_resize', { id, cols, rows }),
    close: id => invoke('terminal_close', { id }),
  };
}
