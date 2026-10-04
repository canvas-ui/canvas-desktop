export function serverUrl(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) server URL without credentials, query or fragment.');
  return url.href.replace(/\/$/, '');
}
export function scopedStorage(storage: Storage, server: string, onToken?: (token: string) => void): Storage {
  const prefix = `canvas.desktop.session:${encodeURIComponent(server)}:`;
  const keys = () => Array.from({ length: storage.length }, (_, i) => storage.key(i)!).filter(k => k.startsWith(prefix));
  return {
    get length() { return keys().length; },
    key(index: number) { return keys()[index]?.slice(prefix.length) ?? null; },
    getItem(key: string) { return storage.getItem(prefix + key); },
    setItem(key: string, value: string) { storage.setItem(prefix + key, value); if (key === 'authToken') onToken?.(value); },
    removeItem(key: string) { storage.removeItem(prefix + key); },
    clear() { keys().forEach(k => storage.removeItem(k)); },
  };
}
