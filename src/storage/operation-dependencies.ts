import { generateId } from "../id.ts";

export interface OperationDependencies {
  readonly now: () => string;
  readonly generateId: () => string;
}

export const defaultOperationDependencies: OperationDependencies = {
  now: () => new Date().toISOString(),
  generateId,
};

export function resolveOperationDependencies(
  overrides: Partial<OperationDependencies> = {},
): OperationDependencies {
  return {
    now: overrides.now ?? defaultOperationDependencies.now,
    generateId: overrides.generateId ?? defaultOperationDependencies.generateId,
  };
}
