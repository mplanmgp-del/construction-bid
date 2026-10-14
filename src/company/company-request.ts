import { fetchApi } from '../live/client';

/** Shared by live company-history sources so they never overwhelm the provider together. */
export function createCompanyRequestGate(limit = 2) {
  let active = 0;
  const queue: Array<() => void> = [];
  const drain = () => { while (active < limit && queue.length) queue.shift()!(); };
  return {
    run<T>(load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const abort = () => {
          const index = queue.indexOf(start);
          if (index !== -1) queue.splice(index, 1);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const start = () => {
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
          active++;
          Promise.resolve().then(load).then(resolve, reject).finally(() => { active--; drain(); });
        };
        signal?.addEventListener('abort', abort, { once: true });
        queue.push(start); drain();
      });
    },
  };
}

const companyRequests = createCompanyRequestGate(2);
export function fetchCompanyApi<T>(path: string, signal?: AbortSignal): Promise<T> {
  return companyRequests.run(() => fetchApi<T>(path, signal), signal);
}
