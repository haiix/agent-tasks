import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { StorageError } from "../errors.ts";

export const DATABASE_ENVIRONMENT_VARIABLE = "AGENT_TASKS_DB";
export const DEFAULT_DATABASE_DIRECTORY = ".agent-tasks";
export const DEFAULT_DATABASE_FILENAME = "tasks.sqlite";

interface PathOperations {
  dirname(path: string): string;
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
}

export interface ResolveDatabasePathOptions {
  readonly command: string;
  readonly cwd: string;
  readonly explicitPath?: string;
  readonly environmentPath?: string;
  readonly pathOperations?: PathOperations;
  readonly pathExists?: (path: string) => boolean;
}

export class NotInitializedError extends Error {
  readonly code = "NOT_INITIALIZED";
  readonly details: Readonly<{ dbPath: string }>;

  constructor(dbPath: string) {
    super("No initialized agent-tasks database was found.");
    this.name = "NotInitializedError";
    this.details = { dbPath };
  }
}

/**
 * Resolves the database selected by CLI precedence and project discovery.
 * Explicit or environment paths take precedence; otherwise non-init commands
 * search the current directory and its ancestors for an initialized database.
 *
 * @throws {@link NotInitializedError} when no usable database can be found.
 */
export function resolveDatabasePath(
  options: ResolveDatabasePathOptions,
): string {
  const paths = options.pathOperations ?? { dirname, join, resolve };
  const exists = options.pathExists ?? databasePathExists;
  const configuredPath = options.explicitPath ?? options.environmentPath;

  if (configuredPath !== undefined) {
    const dbPath = paths.resolve(options.cwd, configuredPath);
    if (options.command === "init" || exists(dbPath)) return dbPath;
    throw new NotInitializedError(dbPath);
  }

  if (options.command === "init") {
    return paths.join(
      paths.resolve(options.cwd),
      DEFAULT_DATABASE_DIRECTORY,
      DEFAULT_DATABASE_FILENAME,
    );
  }

  let directory = paths.resolve(options.cwd);
  const unresolvedPath = paths.join(
    directory,
    DEFAULT_DATABASE_DIRECTORY,
    DEFAULT_DATABASE_FILENAME,
  );
  while (true) {
    const dbPath = paths.join(
      directory,
      DEFAULT_DATABASE_DIRECTORY,
      DEFAULT_DATABASE_FILENAME,
    );
    if (exists(dbPath)) return dbPath;

    const parent = paths.dirname(directory);
    if (parent === directory) throw new NotInitializedError(unresolvedPath);
    directory = parent;
  }
}

function databasePathExists(dbPath: string): boolean {
  try {
    return statSync(dbPath).isFile();
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new StorageError(
      "STORAGE_ERROR",
      "The database path could not be accessed.",
      dbPath,
      error,
    );
  }
}

function getErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "";
  }
  return typeof error.code === "string" ? error.code : "";
}
