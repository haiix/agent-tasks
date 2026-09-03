import type { Priority } from "../domain/task.ts";
import {
  hasExactKeys,
  isPlainObject,
  isValidIdentifier,
  isValidTimestamp,
} from "../validation/primitives.ts";
import { TASK_LIMITS } from "../validation/task.ts";
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

/**
 * Produces the canonical filter identity embedded in list cursors.
 * Pagination cursors cannot be reused after any represented filter changes.
 */
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

/**
 * Decodes and validates a canonical list cursor for the expected filter set.
 *
 * @throws {@link CursorInvalidError} for malformed, non-canonical, unsupported,
 * or filter-mismatched cursors.
 */
export function decodeCursor(value: string, signature: string): CursorPayload {
  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !isPlainObject(payload) ||
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
      !isValidIdentifier(payload.id, TASK_LIMITS.identifierCharacters) ||
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

/**
 * Decodes a canonical history cursor bound to a specific task and page size.
 *
 * @throws {@link CursorInvalidError} when the cursor cannot continue the
 * requested history query.
 */
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
      !isPlainObject(payload) ||
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
