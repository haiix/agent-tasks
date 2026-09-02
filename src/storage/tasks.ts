import { DatabaseSync } from "node:sqlite";

import type {
  CreateTaskInput,
  Priority,
  Task,
  TaskStatus,
  TransitionInput,
  UpdateTaskInput,
} from "../domain/task.ts";
import {
  assertAllowedTransition,
  assertCanReopen,
} from "../domain/transition.ts";
import { DomainError, StorageError } from "../errors.ts";
import {
  TASK_LIMITS,
  isValidTimestamp,
  isWellFormedUnicode,
  validateTask,
  validateTaskDependencies,
} from "../validation/task.ts";
import {
  validateTaskEvent,
  validateTaskEventHistory,
  type ValidatedTaskEvent,
} from "../validation/task-event.ts";
import {
  configureConnection,
  toStorageError,
  verifyDatabaseSchema,
  withTransaction,
} from "./database.ts";
import {
  defaultOperationDependencies,
  type OperationDependencies,
  resolveOperationDependencies,
} from "./operation-dependencies.ts";

export class TaskNotFoundError extends Error {
  readonly code = "TASK_NOT_FOUND";
  readonly details: Readonly<{ taskId: string }>;

  constructor(taskId: string) {
    super("The requested task does not exist.");
    this.name = "TaskNotFoundError";
    this.details = { taskId };
  }
}

export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";
  readonly details: Readonly<{
    taskId: string;
    expectedVersion: number;
    actualVersion: number;
  }>;

  constructor(taskId: string, expectedVersion: number, actualVersion: number) {
    super("Task was modified by another process.");
    this.name = "VersionConflictError";
    this.details = { taskId, expectedVersion, actualVersion };
  }
}

export class NotRunnableError extends Error {
  readonly code = "NOT_RUNNABLE";
  readonly details: Readonly<{
    taskId: string;
    incompleteDependencyIds: readonly string[];
  }>;

  constructor(taskId: string, incompleteDependencyIds: readonly string[]) {
    super("The task has incomplete dependencies and is not runnable.");
    this.name = "NotRunnableError";
    this.details = { taskId, incompleteDependencyIds };
  }
}

export class CursorInvalidError extends Error {
  readonly code = "CURSOR_INVALID";
  readonly details = {};

  constructor() {
    super("The cursor is invalid or does not match the list options.");
    this.name = "CursorInvalidError";
  }
}

export class DependencyNotFoundError extends Error {
  readonly code = "DEPENDENCY_NOT_FOUND";
  readonly details: Readonly<{ taskId: string; dependsOn: string }>;

  constructor(taskId: string, dependsOn: string) {
    super("The requested dependency does not exist.");
    this.name = "DependencyNotFoundError";
    this.details = { taskId, dependsOn };
  }
}

export type DependencyConflictReason = "self" | "duplicate" | "cycle";

export class DependencyConflictError extends Error {
  readonly code = "DEPENDENCY_CONFLICT";
  readonly details: Readonly<{
    taskId: string;
    dependsOn: string;
    reason: DependencyConflictReason;
  }>;

  constructor(
    taskId: string,
    dependsOn: string,
    reason: DependencyConflictReason,
  ) {
    super("The dependency conflicts with the existing dependency graph.");
    this.name = "DependencyConflictError";
    this.details = { taskId, dependsOn, reason };
  }
}

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: Priority;
  readonly assignee: string | null;
  readonly blocked_reason: string | null;
  readonly result: string | null;
  readonly labels_json: string;
  readonly metadata_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly version: number;
  readonly runnable: number;
}

class StoredTaskInvalidError extends Error {
  constructor(cause: unknown) {
    super("Stored task data is invalid.", { cause });
    this.name = "StoredTaskInvalidError";
  }
}

export interface TaskResult {
  readonly task: Task & { readonly runnable: boolean };
  readonly dependsOn: readonly string[];
}

export interface ListFilters {
  readonly status?: TaskStatus;
  readonly priority?: Priority;
  readonly assignee?: string;
  readonly unassigned: boolean;
  readonly label?: string;
  readonly runnable: boolean;
  readonly limit: number;
  readonly cursor?: string;
}

export interface ListResult {
  readonly tasks: readonly (Task & { readonly runnable: boolean })[];
  readonly nextCursor: string | null;
}

export type TaskEvent = ValidatedTaskEvent;

export interface HistoryResult {
  readonly events: readonly TaskEvent[];
  readonly nextCursor: string | null;
}

export interface TaskDependency {
  readonly taskId: string;
  readonly dependsOn: string;
}

export interface ExportResult {
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly tasks: readonly (Task & { readonly runnable: boolean })[];
  readonly dependencies: readonly TaskDependency[];
}

interface TaskEventRow {
  readonly id: string;
  readonly task_id: string;
  readonly type: string;
  readonly actor: string | null;
  readonly occurred_at: string;
  readonly from_version: number | null;
  readonly to_version: number;
  readonly details_json: string;
}

const TASK_SELECT = `
  SELECT t.*,
    CASE WHEN t.status = 'pending' AND NOT EXISTS (
      SELECT 1 FROM task_dependencies d
      JOIN tasks dependency ON dependency.id = d.depends_on
      WHERE d.task_id = t.id AND dependency.status <> 'done'
    ) THEN 1 ELSE 0 END AS runnable
  FROM tasks t`;

const PRIORITY_RANK = `CASE t.priority
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END`;

export function createTask(
  dbPath: string,
  input: CreateTaskInput,
  options: Partial<OperationDependencies> = {},
): TaskResult {
  const dependencies = resolveOperationDependencies(options);
  return withDatabase(dbPath, (database) => {
    const now = dependencies.now();
    const makeId = dependencies.generateId;
    const id = makeId();
    return withTransaction(database, "immediate", () => {
      for (const dependencyId of input.dependsOn) {
        requireTaskRow(database, dependencyId);
      }
      database
        .prepare(
          `INSERT INTO tasks (
          id, title, description, status, priority, assignee, blocked_reason,
          result, labels_json, metadata_json, created_at, updated_at,
          started_at, completed_at, version
        ) VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 1)`,
        )
        .run(
          id,
          input.title,
          input.description,
          input.priority,
          JSON.stringify(input.labels),
          JSON.stringify(input.metadata),
          now,
          now,
        );
      const dependencyInsert = database.prepare(
        "INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)",
      );
      for (const dependencyId of input.dependsOn) {
        dependencyInsert.run(id, dependencyId);
      }
      const result = getTaskInDatabase(database, id);
      database
        .prepare(
          `INSERT INTO task_events (
          id, task_id, type, actor, occurred_at, from_version, to_version, details_json
        ) VALUES (?, ?, 'created', NULL, ?, NULL, 1, ?)`,
        )
        .run(makeId(), id, now, JSON.stringify(result));
      return result;
    });
  });
}

export function getTask(dbPath: string, taskId: string): TaskResult {
  return withDatabase(dbPath, (database) =>
    getTaskInDatabase(database, taskId),
  );
}

export function updateTask(
  dbPath: string,
  taskId: string,
  expectedVersion: number,
  input: UpdateTaskInput,
  options: Partial<OperationDependencies> = {},
): TaskResult {
  const dependencies = resolveOperationDependencies(options);
  return withDatabase(dbPath, (database) => {
    return withTransaction(database, "immediate", () => {
      const before = getTaskInDatabase(database, taskId);
      if (before.task.version !== expectedVersion) {
        throw new VersionConflictError(
          taskId,
          expectedVersion,
          before.task.version,
        );
      }
      const now = dependencies.now();
      const values = {
        title: input.title ?? before.task.title,
        description: input.description ?? before.task.description,
        priority: input.priority ?? before.task.priority,
        labels: input.labels ?? before.task.labels,
        metadata: input.metadata ?? before.task.metadata,
      };
      database
        .prepare(
          `UPDATE tasks SET title = ?, description = ?, priority = ?,
          labels_json = ?, metadata_json = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND version = ?`,
        )
        .run(
          values.title,
          values.description,
          values.priority,
          JSON.stringify(values.labels),
          JSON.stringify(values.metadata),
          now,
          taskId,
          expectedVersion,
        );
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const key of Object.keys(input) as (keyof UpdateTaskInput)[]) {
        changes[key] = { from: before.task[key], to: values[key] };
      }
      database
        .prepare(
          `INSERT INTO task_events (
          id, task_id, type, actor, occurred_at, from_version, to_version, details_json
        ) VALUES (?, ?, 'updated', NULL, ?, ?, ?, ?)`,
        )
        .run(
          dependencies.generateId(),
          taskId,
          now,
          expectedVersion,
          expectedVersion + 1,
          JSON.stringify({ changes }),
        );
      const result = getTaskInDatabase(database, taskId);
      return result;
    });
  });
}

export function claimTask(
  dbPath: string,
  taskId: string,
  agent: string,
  expectedVersion: number,
  options: Partial<OperationDependencies> = {},
): TaskResult {
  const dependencies = resolveOperationDependencies(options);
  return withDatabase(dbPath, (database) => {
    return withTransaction(database, "immediate", () => {
      const before = getTaskInDatabase(database, taskId);
      assertExpectedVersion(before, expectedVersion);
      assertStatus(taskId, before.task.status, ["pending"]);
      assertRunnable(database, taskId);

      const now = dependencies.now();
      const updated = database
        .prepare(
          `UPDATE tasks SET status = 'in_progress', assignee = ?, started_at = ?,
          updated_at = ?, version = version + 1
          WHERE id = ? AND version = ? AND status = 'pending'`,
        )
        .run(agent, now, now, taskId, expectedVersion);
      if (updated.changes !== 1) {
        throw new StorageError(
          "STORAGE_ERROR",
          "The atomic claim update did not modify exactly one task.",
          dbPath,
        );
      }
      insertTaskEvent(database, {
        id: dependencies.generateId(),
        taskId,
        type: "claimed",
        actor: agent,
        occurredAt: now,
        fromVersion: expectedVersion,
        toVersion: expectedVersion + 1,
        details: {
          fromStatus: "pending",
          toStatus: "in_progress",
          assignee: agent,
        },
      });
      const result = getTaskInDatabase(database, taskId);
      return result;
    });
  });
}

export function transitionTask(
  dbPath: string,
  taskId: string,
  to: TaskStatus,
  agent: string,
  expectedVersion: number,
  input: TransitionInput,
  options: Partial<OperationDependencies> = {},
): TaskResult {
  const dependencies = resolveOperationDependencies(options);
  return withDatabase(dbPath, (database) => {
    return withTransaction(database, "immediate", () => {
      const before = getTaskInDatabase(database, taskId);
      assertExpectedVersion(before, expectedVersion);
      try {
        assertAllowedTransition(before.task.status, to);
      } catch (error) {
        throw withTaskId(error, taskId);
      }
      if (before.task.assignee !== null && before.task.assignee !== agent) {
        throw new DomainError(
          "STATE_CONFLICT",
          "The task is assigned to another agent.",
          { taskId, actualStatus: before.task.status },
        );
      }
      if (to === "in_progress") assertRunnable(database, taskId);

      const now = dependencies.now();
      const next = transitionValues(before.task, to, agent, input, now);
      const updated = database
        .prepare(
          `UPDATE tasks SET status = ?, assignee = ?, blocked_reason = ?, result = ?,
          started_at = ?, completed_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND version = ? AND status = ?`,
        )
        .run(
          to,
          next.assignee,
          next.blockedReason,
          next.result,
          next.startedAt,
          next.completedAt,
          now,
          taskId,
          expectedVersion,
          before.task.status,
        );
      if (updated.changes !== 1) {
        throw new StorageError(
          "STORAGE_ERROR",
          "The atomic transition update did not modify exactly one task.",
          dbPath,
        );
      }
      insertTaskEvent(database, {
        id: dependencies.generateId(),
        taskId,
        type: "transitioned",
        actor: agent,
        occurredAt: now,
        fromVersion: expectedVersion,
        toVersion: expectedVersion + 1,
        details: {
          fromStatus: before.task.status,
          toStatus: to,
          blockedReason: next.blockedReason,
          result: next.result,
        },
      });
      const result = getTaskInDatabase(database, taskId);
      return result;
    });
  });
}

export function reopenTask(
  dbPath: string,
  taskId: string,
  agent: string,
  expectedVersion: number,
  options: Partial<OperationDependencies> = {},
): TaskResult {
  const dependencies = resolveOperationDependencies(options);
  return withDatabase(dbPath, (database) => {
    return withTransaction(database, "immediate", () => {
      const before = getTaskInDatabase(database, taskId);
      assertExpectedVersion(before, expectedVersion);
      try {
        assertCanReopen(before.task.status);
      } catch (error) {
        throw withTaskId(error, taskId);
      }

      const now = dependencies.now();
      const updated = database
        .prepare(
          `UPDATE tasks SET status = 'pending', assignee = NULL, blocked_reason = NULL,
          result = NULL, started_at = NULL, completed_at = NULL,
          updated_at = ?, version = version + 1
          WHERE id = ? AND version = ? AND status = ?`,
        )
        .run(now, taskId, expectedVersion, before.task.status);
      if (updated.changes !== 1) {
        throw new StorageError(
          "STORAGE_ERROR",
          "The atomic reopen update did not modify exactly one task.",
          dbPath,
        );
      }
      insertTaskEvent(database, {
        id: dependencies.generateId(),
        taskId,
        type: "reopened",
        actor: agent,
        occurredAt: now,
        fromVersion: expectedVersion,
        toVersion: expectedVersion + 1,
        details: {
          fromStatus: before.task.status,
          toStatus: "pending",
        },
      });
      const result = getTaskInDatabase(database, taskId);
      return result;
    });
  });
}

export function addTaskDependency(
  dbPath: string,
  taskId: string,
  dependsOn: string,
  expectedVersion: number,
  options: Partial<OperationDependencies> = {},
): TaskResult {
  return changeTaskDependency(
    dbPath,
    taskId,
    dependsOn,
    expectedVersion,
    "add",
    options,
  );
}

export function removeTaskDependency(
  dbPath: string,
  taskId: string,
  dependsOn: string,
  expectedVersion: number,
  options: Partial<OperationDependencies> = {},
): TaskResult {
  return changeTaskDependency(
    dbPath,
    taskId,
    dependsOn,
    expectedVersion,
    "remove",
    options,
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
      const result: HistoryResult = {
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
      return result;
    });
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
      const result: ExportResult = {
        schemaVersion: 1,
        exportedAt: (options.now ?? defaultOperationDependencies.now)(),
        tasks,
        dependencies,
      };
      return result;
    });
  });
}

function getTaskInDatabase(database: DatabaseSync, taskId: string): TaskResult {
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

function requireTaskRow(database: DatabaseSync, taskId: string): void {
  if (
    database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId) ===
    undefined
  ) {
    throw new TaskNotFoundError(taskId);
  }
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

function assertExpectedVersion(
  task: TaskResult,
  expectedVersion: number,
): void {
  if (task.task.version !== expectedVersion) {
    throw new VersionConflictError(
      task.task.id,
      expectedVersion,
      task.task.version,
    );
  }
}

function assertStatus(
  taskId: string,
  actualStatus: TaskStatus,
  allowedStatuses: readonly TaskStatus[],
): void {
  if (allowedStatuses.includes(actualStatus)) return;
  throw new DomainError(
    "STATE_CONFLICT",
    "The task is not in a state allowed for this operation.",
    { taskId, actualStatus, allowedStatuses },
  );
}

function assertRunnable(database: DatabaseSync, taskId: string): void {
  const incompleteDependencyIds = database
    .prepare(
      `SELECT d.depends_on FROM task_dependencies d
       JOIN tasks dependency ON dependency.id = d.depends_on
       WHERE d.task_id = ? AND dependency.status <> 'done'
       ORDER BY d.depends_on`,
    )
    .all(taskId)
    .map((row) => row.depends_on as string);
  if (incompleteDependencyIds.length !== 0) {
    throw new NotRunnableError(taskId, incompleteDependencyIds);
  }
}

function withTaskId(error: unknown, taskId: string): unknown {
  if (!(error instanceof DomainError) || error.code !== "STATE_CONFLICT") {
    return error;
  }
  return new DomainError(error.code, error.message, {
    taskId,
    ...error.details,
  });
}

function transitionValues(
  before: Task,
  to: TaskStatus,
  agent: string,
  input: TransitionInput,
  now: string,
): Pick<
  Task,
  "assignee" | "blockedReason" | "result" | "startedAt" | "completedAt"
> {
  if (to === "pending") {
    return {
      assignee: null,
      blockedReason: null,
      result: null,
      startedAt: null,
      completedAt: null,
    };
  }
  if (to === "in_progress") {
    return {
      assignee: agent,
      blockedReason: null,
      result: null,
      startedAt: now,
      completedAt: null,
    };
  }
  if (to === "blocked") {
    return {
      assignee: before.assignee,
      blockedReason:
        input !== undefined && "blockedReason" in input
          ? input.blockedReason
          : null,
      result: null,
      startedAt: before.startedAt,
      completedAt: null,
    };
  }
  if (to === "done") {
    return {
      assignee: before.assignee,
      blockedReason: null,
      result: input !== undefined && "result" in input ? input.result : null,
      startedAt: before.startedAt,
      completedAt: now,
    };
  }
  return {
    assignee: before.assignee,
    blockedReason: null,
    result: null,
    startedAt: before.startedAt,
    completedAt: now,
  };
}

function insertTaskEvent(database: DatabaseSync, event: TaskEvent): void {
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

function changeTaskDependency(
  dbPath: string,
  taskId: string,
  dependsOn: string,
  expectedVersion: number,
  operation: "add" | "remove",
  options: Partial<OperationDependencies>,
): TaskResult {
  const dependencies = resolveOperationDependencies(options);
  return withDatabase(dbPath, (database) => {
    return withTransaction(database, "immediate", () => {
      const before = getTaskInDatabase(database, taskId);
      if (before.task.version !== expectedVersion) {
        throw new VersionConflictError(
          taskId,
          expectedVersion,
          before.task.version,
        );
      }

      if (operation === "add") {
        requireTaskRow(database, dependsOn);
        assertDependencyCanBeAdded(database, taskId, dependsOn, before);
        database
          .prepare(
            "INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)",
          )
          .run(taskId, dependsOn);
      } else {
        const removed = database
          .prepare(
            "DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?",
          )
          .run(taskId, dependsOn);
        if (removed.changes === 0) {
          throw new DependencyNotFoundError(taskId, dependsOn);
        }
      }

      const now = dependencies.now();
      database
        .prepare(
          "UPDATE tasks SET updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
        )
        .run(now, taskId, expectedVersion);
      database
        .prepare(
          `INSERT INTO task_events (
          id, task_id, type, actor, occurred_at, from_version, to_version, details_json
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          dependencies.generateId(),
          taskId,
          operation === "add" ? "dependencyAdded" : "dependencyRemoved",
          now,
          expectedVersion,
          expectedVersion + 1,
          JSON.stringify({ dependsOn }),
        );
      const result = getTaskInDatabase(database, taskId);
      return result;
    });
  });
}

function assertDependencyCanBeAdded(
  database: DatabaseSync,
  taskId: string,
  dependsOn: string,
  task: TaskResult,
): void {
  if (taskId === dependsOn) {
    throw new DependencyConflictError(taskId, dependsOn, "self");
  }
  if (task.dependsOn.includes(dependsOn)) {
    throw new DependencyConflictError(taskId, dependsOn, "duplicate");
  }
  if (task.dependsOn.length >= TASK_LIMITS.dependencies) {
    throw new DomainError("VALIDATION_ERROR", "Input validation failed.", {
      issues: [
        {
          path: "dependsOn",
          code: "too_many",
          message: `Expected at most ${TASK_LIMITS.dependencies} items.`,
        },
      ],
    });
  }
  const createsCycle =
    database
      .prepare(
        `WITH RECURSIVE reachable(id) AS (
          SELECT depends_on FROM task_dependencies WHERE task_id = ?
          UNION
          SELECT dependency.depends_on
          FROM task_dependencies dependency
          JOIN reachable ON dependency.task_id = reachable.id
        )
        SELECT 1 FROM reachable WHERE id = ? LIMIT 1`,
      )
      .get(dependsOn, taskId) !== undefined;
  if (createsCycle) {
    throw new DependencyConflictError(taskId, dependsOn, "cycle");
  }
}

function rowToTask(row: TaskRow): Task & { readonly runnable: boolean } {
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

function cursorSignature(filters: ListFilters): string {
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

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(value: string, signature: string): CursorPayload {
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

function encodeHistoryCursor(payload: HistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeHistoryCursor(
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

function priorityRank(priority: Priority): number {
  return { urgent: 0, high: 1, normal: 2, low: 3 }[priority];
}

function withDatabase<T>(
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
