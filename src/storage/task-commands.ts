import type { DatabaseSync } from "node:sqlite";

import type {
  CreateTaskInput,
  TaskStatus,
  TransitionInput,
  UpdateTaskInput,
} from "../domain/task.ts";
import {
  assertAllowedTransition,
  assertCanReopen,
  deriveTransitionPatch,
} from "../domain/transition.ts";
import { DomainError, StorageError } from "../errors.ts";
import { withTransaction } from "./database.ts";
import { insertTaskEvent } from "./history.ts";
import {
  type OperationDependencies,
  resolveOperationDependencies,
} from "./operation-dependencies.ts";
import {
  getTaskInDatabase,
  requireTaskRow,
  withDatabase,
} from "./task-repository.ts";
import { NotRunnableError, VersionConflictError } from "./storage-errors.ts";
import type { TaskResult } from "./task-types.ts";

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
      insertTaskEvent(database, {
        id: makeId(),
        taskId: id,
        type: "created",
        actor: null,
        occurredAt: now,
        fromVersion: null,
        toVersion: 1,
        details: { ...result },
      });
      return result;
    });
  });
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
      insertTaskEvent(database, {
        id: dependencies.generateId(),
        taskId,
        type: "updated",
        actor: null,
        occurredAt: now,
        fromVersion: expectedVersion,
        toVersion: expectedVersion + 1,
        details: { changes },
      });
      return getTaskInDatabase(database, taskId);
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
      return getTaskInDatabase(database, taskId);
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
      const next = deriveTransitionPatch(before.task, to, agent, input, now);
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
      return getTaskInDatabase(database, taskId);
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
      return getTaskInDatabase(database, taskId);
    });
  });
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
