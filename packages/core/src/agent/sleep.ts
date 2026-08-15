import { HarnessError } from '../errors/index.ts';

/** Abortable sleep — rejects with code 'aborted' so interrupt stays instant. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new HarnessError('aborted', 'sleep aborted', { cause: signal.reason }));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new HarnessError('aborted', 'sleep aborted', { cause: signal.reason }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
