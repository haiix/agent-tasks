export type UnknownRecord = Record<string, unknown>;

export function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys<T extends object>(
  value: UnknownRecord,
  keys: readonly string[],
): value is UnknownRecord & T {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isValidIdentifier(
  value: unknown,
  maxCharacters: number,
): value is string {
  return (
    typeof value === "string" &&
    isWellFormedUnicode(value) &&
    value.trim().length > 0 &&
    [...value].length <= maxCharacters
  );
}

export function isWellFormedUnicode(value: string): boolean {
  return value.isWellFormed();
}

const RFC_3339_UTC_MILLISECONDS =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

export function isValidTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !RFC_3339_UTC_MILLISECONDS.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map(
    (character) => character.codePointAt(0) ?? 0,
  );
  const rightPoints = [...right].map(
    (character) => character.codePointAt(0) ?? 0,
  );
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
