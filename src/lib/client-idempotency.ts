type ActiveOperation = {
  operation: string;
  input: unknown;
  key: string;
};

export type IdempotencyKeyRetainer = {
  keyFor(operation: string, input: unknown): string;
  clear(): void;
};

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
