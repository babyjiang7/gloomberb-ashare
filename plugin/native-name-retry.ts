// A single delayed retry outlives the host search router's short empty-result
// cache. It is cancelled with its lifecycle; this is not a polling interval.
export const NATIVE_NAME_RETRY_DELAY_MS = 10_000;

export function waitForNativeNameRetry(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, NATIVE_NAME_RETRY_DELAY_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}
