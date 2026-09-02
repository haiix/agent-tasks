import type { DatabaseSync } from "node:sqlite";

import {
  validateTaskEvent,
  validateTaskEventHistory,
} from "../validation/task-event.ts";
import { decodeHistoryCursor, encodeHistoryCursor } from "./cursor.ts";
import { withTransaction } from "./database.ts";
import { withDatabase } from "./task-repository.ts";
import {
  CursorInvalidError,
  StoredTaskInvalidError,
  TaskNotFoundError,
} from "./storage-errors.ts";
import type { HistoryResult, TaskEvent, TaskEventRow } from "./task-types.ts";

export function getTaskHistory(
  dbPath: string,
  taskId: string,
  limit: number,
  cursor?: string,
): HistoryResult {
  return withDatabase(dbPath, (database) => {
    return withTransaction(database, "deferred", () => {
      const taskState = requireTaskHistoryState(database, taskId);
      const after =
        cursor === undefined
          ? undefined
          : decodeHistoryCursor(cursor, taskId, limit);
      const rows = database
        .prepare(
          `SELECT id, task_id, type, actor, occurred_at,
           CAST(from_version AS REAL) AS from_version,
           CAST(to_version AS REAL) AS to_version, details_json
           FROM task_events WHERE task_id = ?
           ORDER BY CAST(to_version AS REAL), id`,
        )
        .all(taskId) as unknown as TaskEventRow[];
      const history = rows.map(rowToTaskEvent);
      try {
        validateTaskEventHistory(history, taskState);
      } catch (error) {
        throw new StoredTaskInvalidError(error);
      }
      const currentVersion = history.at(-1)?.toVersion;
      if (
        after !== undefined &&
        (currentVersion === undefined ||
          after.toVersion >= currentVersion ||
          !history.some((event) => event.toVersion === after.toVersion))
      ) {
        throw new CursorInvalidError();
      }
      const remaining =
        after === undefined
          ? history
          : history.filter((event) => event.toVersion > after.toVersion);
      const hasMore = remaining.length > limit;
      const events = remaining.slice(0, limit);
      const last = events.at(-1);
      return {
        events,
        nextCursor:
          hasMore && last !== undefined
            ? encodeHistoryCursor({
                v: 1,
                taskId,
                limit,
                toVersion: last.toVersion,
              })
            : null,
      };
    });
  });
}

export function insertTaskEvent(
  database: DatabaseSync,
  event: TaskEvent,
): void {
  database
    .prepare(
      `INSERT INTO task_events (
       id, task_id, type, actor, occurred_at, from_version, to_version, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.taskId,
      event.type,
      event.actor,
      event.occurredAt,
      event.fromVersion,
      event.toVersion,
      JSON.stringify(event.details),
    );
}

function requireTaskHistoryState(
  database: DatabaseSync,
  taskId: string,
): Readonly<{ version: unknown; status: unknown }> {
  const row = database
    .prepare(
      "SELECT CAST(version AS REAL) AS version, status FROM tasks WHERE id = ?",
    )
    .get(taskId) as Readonly<{ version: unknown; status: unknown }> | undefined;
  if (row === undefined) throw new TaskNotFoundError(taskId);
  return row;
}

function rowToTaskEvent(row: TaskEventRow): TaskEvent {
  try {
    return validateTaskEvent({
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      actor: row.actor,
      occurredAt: row.occurred_at,
      fromVersion: row.from_version,
      toVersion: row.to_version,
      details: JSON.parse(row.details_json) as unknown,
    });
  } catch (error) {
    throw new StoredTaskInvalidError(error);
  }
}
