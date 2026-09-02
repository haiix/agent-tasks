import type { Priority } from "../domain/task.ts";
import {
  TASK_LIMITS,
  isValidTimestamp,
  isWellFormedUnicode,
} from "../validation/task.ts";
import { CursorInvalidError } from "./storage-errors.ts";
import type { ListFilters } from "./task-types.ts";

interface CursorPayload {
  readonly v: 1;
  readonly signature: string;
  readonly rank: number;
  readonly createdAt: string;
  readonly id: string;
}

interface HistoryCursorPayload {
  readonly v: 1;
  readonly taskId: string;
  readonly limit: number;
  readonly toVersion: number;
}

export function cursorSignature(filters: ListFilters): string {
  return JSON.stringify({
    status: filters.status ?? null,
    priority: filters.priority ?? null,
    assignee: filters.assignee ?? null,
    unassigned: filters.unassigned,
    label: filters.label ?? null,
    runnable: filters.runnable,
    limit: filters.limit,
  });
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(value: string, signature: string): CursorPayload {
  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !hasExactKeys<CursorPayload>(payload, [
        "v",
        "signature",
        "rank",
        "createdAt",
        "id",
      ]) ||
      payload.v !== 1 ||
      payload.signature !== signature ||
      !Number.isInteger(payload.rank) ||
      payload.rank < 0 ||
      payload.rank > 3 ||
      typeof payload.createdAt !== "string" ||
      !isValidTimestamp(payload.createdAt) ||
      !isValidIdentifier(payload.id) ||
      encodeCursor(payload) !== value
    ) {
      throw new CursorInvalidError();
    }
    return payload;
  } catch (error) {
    if (error instanceof CursorInvalidError) throw error;
    throw new CursorInvalidError();
  }
}

export function encodeHistoryCursor(payload: HistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeHistoryCursor(
  value: string,
  taskId: string,
  limit: number,
): HistoryCursorPayload {
  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !hasExactKeys<HistoryCursorPayload>(payload, [
        "v",
        "taskId",
        "limit",
        "toVersion",
      ]) ||
      payload.v !== 1 ||
      payload.taskId !== taskId ||
      payload.limit !== limit ||
      !Number.isSafeInteger(payload.toVersion) ||
      payload.toVersion < 1 ||
      encodeHistoryCursor(payload) !== value
    ) {
      throw new CursorInvalidError();
    }
    return payload;
  } catch (error) {
    if (error instanceof CursorInvalidError) throw error;
    throw new CursorInvalidError();
  }
}

export function priorityRank(priority: Priority): number {
  return { urgent: 0, high: 1, normal: 2, low: 3 }[priority];
}

function hasExactKeys<T extends object>(
  value: unknown,
  keys: readonly (keyof T & string)[],
): value is T {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= TASK_LIMITS.identifierCharacters &&
    isWellFormedUnicode(value)
  );
}
