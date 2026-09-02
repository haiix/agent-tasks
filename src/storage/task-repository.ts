import { DatabaseSync } from "node:sqlite";

import type { Task } from "../domain/task.ts";
import { DomainError, StorageError } from "../errors.ts";
import { validateTask, validateTaskDependencies } from "../validation/task.ts";
import {
  configureConnection,
  toStorageError,
  verifyDatabaseSchema,
  withTransaction,
} from "./database.ts";
import {
  cursorSignature,
  decodeCursor,
  encodeCursor,
  priorityRank,
} from "./cursor.ts";
import { defaultOperationDependencies } from "./operation-dependencies.ts";
import type { OperationDependencies } from "./operation-dependencies.ts";
import {
  CursorInvalidError,
  DependencyConflictError,
  DependencyNotFoundError,
  NotRunnableError,
  StoredTaskInvalidError,
  TaskNotFoundError,
  VersionConflictError,
} from "./storage-errors.ts";
import type {
  ExportResult,
  ListFilters,
  ListResult,
  TaskDependency,
  TaskResult,
  TaskRow,
} from "./task-types.ts";

export const TASK_SELECT = `
  SELECT t.*,
    CASE WHEN t.status = 'pending' AND NOT EXISTS (
      SELECT 1 FROM task_dependencies d
      JOIN tasks dependency ON dependency.id = d.depends_on
      WHERE d.task_id = t.id AND dependency.status <> 'done'
    ) THEN 1 ELSE 0 END AS runnable
  FROM tasks t`;

export const PRIORITY_RANK = `CASE t.priority
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END`;

export function getTask(dbPath: string, taskId: string): TaskResult {
  return withDatabase(dbPath, (database) =>
    getTaskInDatabase(database, taskId),
  );
}

export function listTasks(dbPath: string, filters: ListFilters): ListResult {
  return withDatabase(dbPath, (database) => {
    const signature = cursorSignature(filters);
    const after =
      filters.cursor === undefined
        ? undefined
        : decodeCursor(filters.cursor, signature);
    const where: string[] = [];
    const parameters: (string | number)[] = [];
    if (filters.status !== undefined) {
      where.push("t.status = ?");
      parameters.push(filters.status);
    }
    if (filters.priority !== undefined) {
      where.push("t.priority = ?");
      parameters.push(filters.priority);
    }
    if (filters.assignee !== undefined) {
      where.push("t.assignee = ?");
      parameters.push(filters.assignee);
    }
    if (filters.unassigned) where.push("t.assignee IS NULL");
    if (filters.label !== undefined) {
      where.push(
        "EXISTS (SELECT 1 FROM json_each(t.labels_json) WHERE value = ?)",
      );
      parameters.push(filters.label);
    }
    if (filters.runnable) {
      where.push(`t.status = 'pending' AND NOT EXISTS (
        SELECT 1 FROM task_dependencies rd
        JOIN tasks rt ON rt.id = rd.depends_on
        WHERE rd.task_id = t.id AND rt.status <> 'done')`);
    }
    if (after !== undefined) {
      const referencedTask = database
        .prepare(
          `SELECT 1 FROM tasks t
           WHERE ${[...where, `${PRIORITY_RANK} = ?`, "t.created_at = ?", "t.id = ?"].join(" AND ")}
           LIMIT 1`,
        )
        .get(...parameters, after.rank, after.createdAt, after.id);
      if (referencedTask === undefined) throw new CursorInvalidError();
      where.push(`(${PRIORITY_RANK} > ? OR (${PRIORITY_RANK} = ? AND
        (t.created_at > ? OR (t.created_at = ? AND t.id > ?))))`);
      parameters.push(
        after.rank,
        after.rank,
        after.createdAt,
        after.createdAt,
        after.id,
      );
    }
    const rows = database
      .prepare(
        `${TASK_SELECT} ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
        ORDER BY ${PRIORITY_RANK}, t.created_at, t.id LIMIT ?`,
      )
      .all(...parameters, filters.limit + 1) as unknown as TaskRow[];
    const hasMore = rows.length > filters.limit;
    const page = rows.slice(0, filters.limit);
    const tasks = page.map(rowToTask);
    const last = page.at(-1);
    return {
      tasks,
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({
              v: 1,
              signature,
              rank: priorityRank(last.priority),
              createdAt: last.created_at,
              id: last.id,
            })
          : null,
    };
  });
}

export function exportTasks(
  dbPath: string,
  options: Partial<Pick<OperationDependencies, "now">> = {},
): ExportResult {
  return withDatabase(dbPath, (database) => {
    return withTransaction(database, "deferred", () => {
      const tasks = (
        database
          .prepare(`${TASK_SELECT} ORDER BY t.id`)
          .all() as unknown as TaskRow[]
      ).map(rowToTask);
      const dependencies = database
        .prepare(
          `SELECT task_id AS taskId, depends_on AS dependsOn
           FROM task_dependencies ORDER BY task_id, depends_on`,
        )
        .all() as unknown as TaskDependency[];
      return {
        schemaVersion: 1,
        exportedAt: (options.now ?? defaultOperationDependencies.now)(),
        tasks,
        dependencies,
      };
    });
  });
}

export function getTaskInDatabase(
  database: DatabaseSync,
  taskId: string,
): TaskResult {
  const row = database.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(taskId) as
    TaskRow | undefined;
  if (row === undefined) throw new TaskNotFoundError(taskId);
  const dependencies = database
    .prepare(
      "SELECT depends_on FROM task_dependencies WHERE task_id = ? ORDER BY depends_on",
    )
    .all(taskId) as unknown as { depends_on: string }[];
  try {
    return {
      task: rowToTask(row),
      dependsOn: validateTaskDependencies(
        dependencies.map((dependency) => dependency.depends_on),
      ),
    };
  } catch (error) {
    if (error instanceof StoredTaskInvalidError) throw error;
    throw new StoredTaskInvalidError(error);
  }
}

export function requireTaskRow(database: DatabaseSync, taskId: string): void {
  if (
    database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId) ===
    undefined
  ) {
    throw new TaskNotFoundError(taskId);
  }
}

export function rowToTask(row: TaskRow): Task & { readonly runnable: boolean } {
  try {
    const task = validateTask({
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      assignee: row.assignee,
      blockedReason: row.blocked_reason,
      result: row.result,
      labels: JSON.parse(row.labels_json) as unknown,
      metadata: JSON.parse(row.metadata_json) as unknown,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      version: row.version,
    });
    return { ...task, runnable: row.runnable === 1 };
  } catch (error) {
    throw new StoredTaskInvalidError(error);
  }
}

export function withDatabase<T>(
  dbPath: string,
  operation: (database: DatabaseSync) => T,
): T {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(dbPath);
    configureConnection(database);
    verifyDatabaseSchema(database, dbPath);
    return operation(database);
  } catch (error) {
    if (error instanceof StoredTaskInvalidError) {
      throw new StorageError(
        "DB_INVALID",
        "Stored task data is invalid.",
        dbPath,
        error,
      );
    }
    if (
      error instanceof TaskNotFoundError ||
      error instanceof VersionConflictError ||
      error instanceof NotRunnableError ||
      error instanceof CursorInvalidError ||
      error instanceof DependencyNotFoundError ||
      error instanceof DependencyConflictError ||
      error instanceof DomainError ||
      error instanceof StorageError
    ) {
      throw error;
    }
    throw toStorageError(error, dbPath);
  } finally {
    database?.close();
  }
}
