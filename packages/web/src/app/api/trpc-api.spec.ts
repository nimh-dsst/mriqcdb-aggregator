import { abortable } from './trpc-api';

describe('abortable', () => {
  it('hands the call an AbortSignal and aborts it on unsubscribe', () => {
    let seen: AbortSignal | null = null;
    const source = abortable<number>((signal) => {
      seen = signal;
      return new Promise<number>(() => undefined);
    });

    const subscription = source.subscribe();
    const signal = seen as AbortSignal | null;
    expect(signal).not.toBeNull();
    expect(signal?.aborted).toBe(false);
    // Cancelling a key has to reach the network, not only the subscriber:
    // `takeUntil` alone leaves the request running and the server answering it.
    subscription.unsubscribe();
    expect(signal?.aborted).toBe(true);
  });

  it('delivers a result and completes', async () => {
    const values: number[] = [];
    let done = false;
    await new Promise<void>((resolve) => {
      abortable<number>(() => Promise.resolve(7)).subscribe({
        next: (value) => values.push(value),
        complete: () => {
          done = true;
          resolve();
        },
      });
    });
    expect(values).toEqual([7]);
    expect(done).toBe(true);
  });

  it('reports a rejection, but says nothing after an abort', async () => {
    const errors: unknown[] = [];
    await new Promise<void>((resolve) => {
      abortable<number>(() => Promise.reject(new Error('boom'))).subscribe({
        error: (error: unknown) => {
          errors.push(error);
          resolve();
        },
      });
    });
    expect(errors).toHaveLength(1);

    const quiet: unknown[] = [];
    const subscription = abortable<number>(
      (signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ).subscribe({ error: (error: unknown) => quiet.push(error) });
    subscription.unsubscribe();
    await Promise.resolve();
    expect(quiet).toEqual([]);
  });
});
