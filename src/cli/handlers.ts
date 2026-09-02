import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  PRIORITIES,
  TASK_STATUSES,
  type Priority,
  type TaskStatus,
} from "../domain/task.ts";
import { installSkill } from "../skill.ts";
import { initializeDatabase } from "../storage/database.ts";
import {
  DATABASE_ENVIRONMENT_VARIABLE,
  resolveDatabasePath,
} from "../storage/path.ts";
import {
  addTaskDependency,
  claimTask,
  createTask,
  exportTasks,
  getTask,
  getTaskHistory,
  listTasks,
  reopenTask,
  removeTaskDependency,
  transitionTask,
  updateTask,
} from "../storage/tasks.ts";
import {
  validateCreateTaskInput,
  validateTransitionInput,
  validateUpdateTaskInput,
} from "../validation/task.ts";
import {
  CliFailure,
  optionalEnum,
  optionalIdentifier,
  optionalInteger,
  type ParsedOptions,
  readJson,
  requiredEnum,
  requiredIdentifier,
  requiredInteger,
} from "./parser.ts";
import type { Command } from "./spec.ts";

export interface CliIo {
  writeStdout(value: string): void;
  readonly readStdin?: () => string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export function executeCommand(
  command: Command,
  options: ParsedOptions,
  io: CliIo,
): object {
  switch (command) {
    case "init": {
      const dbPath = databasePath(command, options.values.get("--db"), io);
      const result = initializeDatabase(dbPath);
      return {
        dbPath,
        schemaVersion: result.schemaVersion,
        created: result.created,
      };
    }
    case "skill-install": {
      const projectRoot = resolveSkillProjectRoot(
        options.values.get("--project"),
        io.cwd ?? process.cwd(),
      );
      return installSkill(projectRoot);
    }
    case "create": {
      const input = validateCreateTaskInput(readJson(options, io.readStdin));
      const dbPath = databasePath(command, options.values.get("--db"), io);
      return createTask(dbPath, input);
    }
    case "get": {
      const taskId = requiredIdentifier(options, "--id");
      const dbPath = databasePath(command, options.values.get("--db"), io);
      return getTask(dbPath, taskId);
    }
    case "list": {
      const status = optionalEnum(options, "--status", TASK_STATUSES);
      const priority = optionalEnum(options, "--priority", PRIORITIES);
      const assignee = optionalIdentifier(options, "--assignee");
      const label = optionalIdentifier(options, "--label");
      const cursor = options.values.get("--cursor");
      if (assignee !== undefined && options.flags.has("--unassigned")) {
        throw invalidArgument(
          "--unassigned",
          undefined,
          "--assignee and --unassigned cannot be combined.",
        );
      }
      const limit = optionalInteger(options, "--limit", 50, 1, 200);
      const dbPath = databasePath(command, options.values.get("--db"), io);
      return listTasks(dbPath, {
        ...(status === undefined ? {} : { status: status as TaskStatus }),
        ...(priority === undefined ? {} : { priority: priority as Priority }),
        ...(assignee === undefined ? {} : { assignee }),
        ...(label === undefined ? {} : { label }),
        unassigned: options.flags.has("--unassigned"),
        runnable: options.flags.has("--runnable"),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
    }
    case "update": {
      const taskId = requiredIdentifier(options, "--id");
      const expectedVersion = requiredInteger(options, "--expected-version", 1);
      const input = validateUpdateTaskInput(readJson(options, io.readStdin));
      const dbPath = databasePath(command, options.values.get("--db"), io);
      return updateTask(dbPath, taskId, expectedVersion, input);
    }
    case "claim": {
      const taskId = requiredIdentifier(options, "--id");
      const agent = requiredIdentifier(options, "--agent");
      const expectedVersion = requiredInteger(options, "--expected-version", 1);
      const dbPath = databasePath(command, options.values.get("--db"), io);
      return claimTask(dbPath, taskId, agent, expectedVersion);
    }
    case "transition": {
      const taskId = requiredIdentifier(options, "--id");
      const to = requiredEnum(options, "--to", TASK_STATUSES) as TaskStatus;
      const agent = requiredIdentifier(options, "--agent");
      const expectedVersion = requiredInteger(options, "--expected-version", 1);
      const input = validateTransitionInput(
        to,
        options.values.has("--input-json")
          ? readJson(options, io.readStdin)
          : undefined,
      );
      const dbPath = databasePath(command, options.values.get("--db"), io);
      return transitionTask(dbPath, taskId, to, agent, expectedVersion, input);
    }
    case "reopen": {
      const taskId = requiredIdentifier(options, "--id");
      const agent = requiredIdentifier(options, "--agent");
      const expectedVersion = requiredInteger(options, "--expected-version", 1);
      const dbPath = databasePath(command, options.values.get("--db"), io);
      return reopenTask(dbPath, taskId, agent, expectedVersion);
    }
    case "history": {
      const taskId = requiredIdentifier(options, "--id");
      const limit = optionalInteger(options, "--limit", 100, 1, 500);
      const cursor = options.values.get("--cursor");
      const dbPath = databasePath(command, options.values.get("--db"), io);
      return getTaskHistory(dbPath, taskId, limit, cursor);
    }
    case "export": {
      const dbPath = databasePath(command, options.values.get("--db"), io);
      return exportTasks(dbPath);
    }
    case "dependency-add":
    case "dependency-remove": {
      const taskId = requiredIdentifier(options, "--id");
      const dependsOn = requiredIdentifier(options, "--depends-on");
      const expectedVersion = requiredInteger(options, "--expected-version", 1);
      const dbPath = databasePath(command, options.values.get("--db"), io);
      const changeDependency =
        command === "dependency-add" ? addTaskDependency : removeTaskDependency;
      return changeDependency(dbPath, taskId, dependsOn, expectedVersion);
    }
  }
}

function databasePath(
  command: string,
  explicitPath: string | undefined,
  io: CliIo,
): string {
  const environment = io.environment ?? process.env;
  return resolveDatabasePath({
    command,
    cwd: io.cwd ?? process.cwd(),
    ...(explicitPath === undefined ? {} : { explicitPath }),
    ...(environment[DATABASE_ENVIRONMENT_VARIABLE] === undefined
      ? {}
      : { environmentPath: environment[DATABASE_ENVIRONMENT_VARIABLE] }),
  });
}

function resolveSkillProjectRoot(
  explicitProject: string | undefined,
  cwd: string,
): string {
  if (explicitProject !== undefined) {
    const projectRoot = resolve(cwd, explicitProject);
    try {
      if (statSync(projectRoot).isDirectory()) return projectRoot;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    throw invalidArgument(
      "--project",
      explicitProject,
      "The project path must be an existing directory.",
    );
  }
  const dbPath = resolveDatabasePath({ command: "skill-install", cwd });
  return dirname(dirname(dbPath));
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function invalidArgument(
  option: string | undefined,
  value: string | undefined,
  message: string,
): CliFailure {
  return new CliFailure("INVALID_ARGUMENT", message, {
    ...(option === undefined ? {} : { option }),
    ...(value === undefined ? {} : { value }),
  });
}
