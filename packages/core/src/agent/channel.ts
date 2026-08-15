/**
 * Minimal async channel: producers push, one consumer iterates, close ends
 * iteration after the queue drains. Lets the loop yield tool_call_progress
 * events LIVE while a tool executes (step 10), with no timers or polling.
 */
export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
}

export function makeChannel<T>(): Channel<T> {
  const queue: T[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  return {
    push(value: T): void {
      if (closed) {
        return;
      }
      queue.push(value);
      wake?.();
      wake = null;
    },
    close(): void {
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
  };
}
