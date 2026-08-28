type RetainedOperation = { operation: string; input: unknown; key: string };
export type IdempotencyKeyRetainer = { keyFor(operation: string, input: unknown): string; clear(operation?: string, input?: unknown): void };
export class UnknownNetworkOutcome extends Error {
  constructor() { super("The request outcome is unknown. Retry the same action to reuse its idempotency key."); this.name = "UnknownNetworkOutcome"; }
}
export function createIdempotencyKeyRetainer(generateKey: () => string = () => globalThis.crypto.randomUUID()): IdempotencyKeyRetainer {
  const retained: RetainedOperation[] = [];
  return {
    keyFor(operation, input) {
      const existing = retained.find((item) => item.operation === operation && Object.is(item.input, input));
      if (existing) return existing.key;
      const next = { operation, input, key: generateKey() }; retained.push(next); return next.key;
    },
    clear(operation, input) {
      if (operation === undefined) { retained.length = 0; return; }
      for (let index = retained.length - 1; index >= 0; index -= 1) {
        if (retained[index].operation === operation && Object.is(retained[index].input, input)) retained.splice(index, 1);
      }
    },
  };
}
export async function withRetainedIdempotencyKey<T>(
  retainer: IdempotencyKeyRetainer, operation: string, input: unknown, request: (key: string) => Promise<T>,
): Promise<T> {
  const key = retainer.keyFor(operation, input);
  try { const result = await request(key); retainer.clear(operation, input); return result; }
  catch (error) {
    if (!(error instanceof UnknownNetworkOutcome)) { retainer.clear(operation, input); throw error; }
    try { const replay = await request(key); retainer.clear(operation, input); return replay; }
    catch (replayError) { if (!(replayError instanceof UnknownNetworkOutcome)) retainer.clear(operation, input); throw replayError; }
  }
}
