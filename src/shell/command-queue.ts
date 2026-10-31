/** Serialize native page lifecycle commands per host window, including cleanup. */
export function createCommandQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return function enqueue<T>(window: string, run: () => Promise<T>): Promise<T> {
    const result = (pending.get(window) || Promise.resolve()).catch(() => {}).then(run);
    pending.set(window, result);
    const release = () => { if (pending.get(window) === result) pending.delete(window); };
    void result.then(release, release);
    return result;
  };
}
