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

export class StoredTaskInvalidError extends Error {
  constructor(cause: unknown) {
    super("Stored task data is invalid.", { cause });
    this.name = "StoredTaskInvalidError";
  }
}
