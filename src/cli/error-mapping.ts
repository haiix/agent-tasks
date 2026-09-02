import { DomainError, StorageError } from "../errors.ts";
import { SkillConflictError } from "../skill.ts";
import { NotInitializedError } from "../storage/path.ts";
import {
  CursorInvalidError,
  DependencyConflictError,
  DependencyNotFoundError,
  NotRunnableError,
  TaskNotFoundError,
  VersionConflictError,
} from "../storage/tasks.ts";
import { CliFailure } from "./parser.ts";

export interface MappedCliError {
  readonly exitCode: number;
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export function mapCliError(error: unknown): MappedCliError {
  if (error instanceof CliFailure) return withExitCode(2, error);
  if (error instanceof DomainError) {
    return withExitCode(error.code === "STATE_CONFLICT" ? 4 : 2, error);
  }
  if (error instanceof CursorInvalidError) return withExitCode(2, error);
  if (
    error instanceof NotInitializedError ||
    error instanceof TaskNotFoundError ||
    error instanceof DependencyNotFoundError
  ) {
    return withExitCode(3, error);
  }
  if (
    error instanceof VersionConflictError ||
    error instanceof NotRunnableError ||
    error instanceof DependencyConflictError ||
    error instanceof SkillConflictError
  ) {
    return withExitCode(4, error);
  }
  if (error instanceof StorageError) return withExitCode(5, error);
  return {
    exitCode: 5,
    code: "INTERNAL_ERROR",
    message: "An unexpected internal error occurred.",
    details: {},
  };
}

function withExitCode(
  exitCode: number,
  error: {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  },
): MappedCliError {
  return {
    exitCode,
    code: error.code,
    message: error.message,
    details: error.details,
  };
}
