import type { DatabaseSync } from "node:sqlite";

import { DomainError } from "../errors.ts";
import { TASK_LIMITS } from "../validation/task.ts";
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
import {
  DependencyConflictError,
  DependencyNotFoundError,
  VersionConflictError,
} from "./storage-errors.ts";
import type { TaskResult } from "./task-types.ts";

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
      insertTaskEvent(database, {
        id: dependencies.generateId(),
        taskId,
        type: operation === "add" ? "dependencyAdded" : "dependencyRemoved",
        actor: null,
        occurredAt: now,
        fromVersion: expectedVersion,
        toVersion: expectedVersion + 1,
        details: { dependsOn },
      });
      return getTaskInDatabase(database, taskId);
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
