import { readFileSync } from "node:fs";

import {
  PRIORITIES,
  TASK_STATUSES,
  type Priority,
  type TaskStatus,
} from "./domain/task.ts";
import { DomainError, StorageError } from "./errors.ts";
import { initializeDatabase } from "./storage/database.ts";
import {
  CursorInvalidError,
  createTask,
  getTask,
  listTasks,
  TaskNotFoundError,
  updateTask,
  VersionConflictError,
} from "./storage/tasks.ts";
import {
  DATABASE_ENVIRONMENT_VARIABLE,
  NotInitializedError,
  resolveDatabasePath,
} from "./storage/path.ts";
import {
  TASK_LIMITS,
  validateCreateTaskInput,
  validateUpdateTaskInput,
} from "./validation/task.ts";

export interface CliIo {
  writeStdout(value: string): void;
  readonly readStdin?: () => string;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}
export interface CliResult {
  exitCode: number;
}
type Command = "init" | "create" | "get" | "list" | "update";
type Format = "json" | "text";
const COMMANDS: readonly Command[] = [
  "init",
  "create",
  "get",
  "list",
  "update",
];

export function runCli(args: readonly string[], io: CliIo): CliResult {
  const command = args[0] ?? null;
  if (command === null)
    return writeError(io, 2, "INVALID_ARGUMENT", "A command is required.", {});
  if (!COMMANDS.includes(command as Command)) {
    return writeError(io, 2, "UNKNOWN_COMMAND", `Unknown command: ${command}`, {
      command,
    });
  }
  try {
    const parsed = parseOptions(command as Command, args.slice(1));
    const format = parseFormat(parsed.values.get("--format"));
    if (format === "text" && command !== "get" && command !== "list") {
      throw new CliFailure(
        "UNSUPPORTED_FORMAT",
        `The ${command} command does not support text output.`,
        { format: "text" },
      );
    }
    switch (command as Command) {
      case "init": {
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        const result = initializeDatabase(dbPath);
        return writeSuccess(io, {
          dbPath,
          schemaVersion: result.schemaVersion,
          created: result.created,
        });
      }
      case "create": {
        const input = validateCreateTaskInput(readJson(parsed, io));
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeSuccess(io, createTask(dbPath, input));
      }
      case "get": {
        const taskId = requiredIdentifier(parsed, "--id");
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeOutput(io, format, getTask(dbPath, taskId));
      }
      case "list": {
        const status = optionalEnum(parsed, "--status", TASK_STATUSES);
        const priority = optionalEnum(parsed, "--priority", PRIORITIES);
        const assignee = optionalIdentifier(parsed, "--assignee");
        const label = optionalIdentifier(parsed, "--label");
        const cursor = parsed.values.get("--cursor");
        if (assignee !== undefined && parsed.flags.has("--unassigned")) {
          throw invalidArgument(
            "--unassigned",
            undefined,
            "--assignee and --unassigned cannot be combined.",
          );
        }
        const limit = optionalInteger(parsed, "--limit", 50, 1, 200);
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeOutput(
          io,
          format,
          listTasks(dbPath, {
            ...(status === undefined ? {} : { status: status as TaskStatus }),
            ...(priority === undefined
              ? {}
              : { priority: priority as Priority }),
            ...(assignee === undefined ? {} : { assignee }),
            ...(label === undefined ? {} : { label }),
            unassigned: parsed.flags.has("--unassigned"),
            runnable: parsed.flags.has("--runnable"),
            limit,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
      }
      case "update": {
        const taskId = requiredIdentifier(parsed, "--id");
        const expectedVersion = requiredInteger(
          parsed,
          "--expected-version",
          1,
        );
        const input = validateUpdateTaskInput(readJson(parsed, io));
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeSuccess(
          io,
          updateTask(dbPath, taskId, expectedVersion, input),
        );
      }
    }
  } catch (error) {
    if (error instanceof CliFailure)
      return writeError(io, 2, error.code, error.message, error.details);
    if (error instanceof DomainError)
      return writeError(io, 2, error.code, error.message, error.details);
    if (error instanceof CursorInvalidError)
      return writeError(io, 2, error.code, error.message, error.details);
    if (
      error instanceof NotInitializedError ||
      error instanceof TaskNotFoundError
    ) {
      return writeError(io, 3, error.code, error.message, error.details);
    }
    if (error instanceof VersionConflictError)
      return writeError(io, 4, error.code, error.message, error.details);
    if (error instanceof StorageError)
      return writeError(io, 5, error.code, error.message, error.details);
    return writeError(
      io,
      5,
      "INTERNAL_ERROR",
      "An unexpected internal error occurred.",
      {},
    );
  }
}

interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}
const VALUE_OPTIONS: Readonly<Record<Command, readonly string[]>> = {
  init: ["--db", "--format"],
  create: ["--db", "--format", "--input-json"],
  get: ["--db", "--format", "--id"],
  list: [
    "--db",
    "--format",
    "--status",
    "--priority",
    "--assignee",
    "--label",
    "--limit",
    "--cursor",
  ],
  update: ["--db", "--format", "--id", "--expected-version", "--input-json"],
};
const FLAG_OPTIONS: Readonly<Record<Command, readonly string[]>> = {
  init: [],
  create: [],
  get: [],
  update: [],
  list: ["--unassigned", "--runnable"],
};

function parseOptions(
  command: Command,
  args: readonly string[],
): ParsedOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (
      option === undefined ||
      (!VALUE_OPTIONS[command].includes(option) &&
        !FLAG_OPTIONS[command].includes(option))
    ) {
      throw invalidArgument(option, undefined, "Unknown option.");
    }
    if (values.has(option) || flags.has(option))
      throw invalidArgument(
        option,
        undefined,
        "An option was specified more than once.",
      );
    if (FLAG_OPTIONS[command].includes(option)) {
      flags.add(option);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw invalidArgument(option, undefined, "An option value is required.");
    }
    values.set(option, value);
    index += 1;
  }
  return { values, flags };
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

function readJson(options: ParsedOptions, io: CliIo): unknown {
  const value = options.values.get("--input-json");
  if (value === undefined)
    throw invalidArgument(
      "--input-json",
      undefined,
      "A required option is missing.",
    );
  try {
    const source = value === "-" ? (io.readStdin ?? readProcessStdin)() : value;
    if (source.length === 0) throw new Error("empty");
    const parsed = JSON.parse(source) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("root");
    return parsed;
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw new CliFailure(
      "INVALID_JSON",
      "Input must be a valid JSON object.",
      {},
    );
  }
}

function readProcessStdin(): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(0));
}

function requiredIdentifier(options: ParsedOptions, name: string): string {
  const value = options.values.get(name);
  if (value === undefined)
    throw invalidArgument(name, undefined, "A required option is missing.");
  if (
    [...value].length > TASK_LIMITS.identifierCharacters ||
    value.trim().length === 0
  ) {
    throw invalidArgument(name, value, "Invalid identifier.");
  }
  return value;
}
function optionalIdentifier(
  options: ParsedOptions,
  name: string,
): string | undefined {
  return options.values.has(name)
    ? requiredIdentifier(options, name)
    : undefined;
}
function requiredInteger(
  options: ParsedOptions,
  name: string,
  minimum: number,
): number {
  const value = options.values.get(name);
  if (value === undefined)
    throw invalidArgument(name, undefined, "A required option is missing.");
  if (!/^(?:0|[1-9]\d*)$/.test(value))
    throw invalidArgument(name, value, "Expected a decimal integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw invalidArgument(name, value, "Integer is outside the allowed range.");
  return parsed;
}
function optionalInteger(
  options: ParsedOptions,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (!options.values.has(name)) return defaultValue;
  const value = requiredInteger(options, name, minimum);
  if (value > maximum)
    throw invalidArgument(
      name,
      String(value),
      "Integer is outside the allowed range.",
    );
  return value;
}
function optionalEnum(
  options: ParsedOptions,
  name: string,
  allowed: readonly string[],
): string | undefined {
  const value = options.values.get(name);
  if (value !== undefined && !allowed.includes(value))
    throw invalidArgument(name, value, "Invalid option value.");
  return value;
}
function parseFormat(value: string | undefined): Format {
  if (value === undefined || value === "json") return "json";
  if (value === "text") return "text";
  throw invalidArgument("--format", value, "Invalid option value.");
}

class CliFailure extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CliFailure";
    this.code = code;
    this.details = details;
  }
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
function writeOutput(io: CliIo, format: Format, data: object): CliResult {
  if (format === "json") return writeSuccess(io, data);
  io.writeStdout(`${JSON.stringify(data, null, 2)}\n`);
  return { exitCode: 0 };
}
function writeSuccess(io: CliIo, data: object): CliResult {
  io.writeStdout(`${JSON.stringify({ ok: true, data })}\n`);
  return { exitCode: 0 };
}
function writeError(
  io: CliIo,
  exitCode: number,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): CliResult {
  io.writeStdout(
    `${JSON.stringify({ ok: false, error: { code, message, details } })}\n`,
  );
  return { exitCode };
}
