import type { TabAction } from './model';
export function tabShortcut(event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string }): TabAction | 'address' | 'reload' | 'back' | 'forward' | undefined {
  if (event.altKey && !event.ctrlKey && !event.metaKey) return event.code === 'ArrowLeft' ? 'back' : event.code === 'ArrowRight' ? 'forward' : undefined;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return event.code === 'F5' ? 'reload' : undefined;
  if (event.code === 'KeyT' && event.shiftKey) return 'reopen-tab';
  if (event.code === 'KeyT' && !event.shiftKey) return 'new-tab';
  if (event.code === 'KeyN' && !event.shiftKey) return 'new-window';
  if (event.code === 'KeyW' && !event.shiftKey) return 'close-tab';
  if (event.code === 'KeyL') return 'address';
  if (event.code === 'KeyR') return 'reload';
  if (event.code === 'Tab') return event.shiftKey ? 'previous-tab' : 'next-tab';
  if (event.code === 'PageUp') return 'previous-tab';
  if (event.code === 'PageDown') return 'next-tab';
  if (/^Digit[1-9]$/.test(event.code)) return `select-${Number(event.code.slice(-1))}`;
}
