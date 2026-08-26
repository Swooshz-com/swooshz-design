type ActiveOperation = {
  operation: string;
  input: unknown;
  key: string;
};

export type IdempotencyKeyRetainer = {
  keyFor(operation: string, input: unknown): string;
  clear(): void;
};
export class UnknownNetworkOutcome extends Error {
  constructor() {
    super("The request outcome is unknown. Retry the same action to reuse its idempotency key.");
    this.name = "UnknownNetworkOutcome";
  }
}

export function createIdempotencyKeyRetainer(
  generateKey: () => string = () => globalThis.crypto.randomUUID(),
): IdempotencyKeyRetainer {
  let active: ActiveOperation | null = null;

  return {
    keyFor(operation, input) {
      if (!active || active.operation !== operation || !Object.is(active.input, input)) {
        active = { operation, input, key: generateKey() };
      }
      return active.key;
    },
    clear() {
      active = null;
    },
  };
}

export async function withRetainedIdempotencyKey<T>(
  retainer: IdempotencyKeyRetainer,
  operation: string,
  input: unknown,
  request: (key: string) => Promise<T>,
): Promise<T> {
  const key = retainer.keyFor(operation, input);
  try {
    const result = await request(key);
    retainer.clear();
    return result;
  } catch (error) {
    if (!(error instanceof UnknownNetworkOutcome)) {
      retainer.clear();
      throw error;
    }
    try {
      const replay = await request(key);
      retainer.clear();
      return replay;
    } catch (replayError) {
      if (!(replayError instanceof UnknownNetworkOutcome)) retainer.clear();
      throw replayError;
    }
  }
}
