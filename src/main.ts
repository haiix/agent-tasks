import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  PRIORITIES,
  TASK_STATUSES,
  type Priority,
  type TaskStatus,
} from "./domain/task.ts";
import { DomainError, StorageError } from "./errors.ts";
import { installSkill, SkillConflictError } from "./skill.ts";
import { initializeDatabase } from "./storage/database.ts";
import {
  addTaskDependency,
  claimTask,
  CursorInvalidError,
  createTask,
  DependencyConflictError,
  DependencyNotFoundError,
  exportTasks,
  getTask,
  getTaskHistory,
  listTasks,
  NotRunnableError,
  reopenTask,
  removeTaskDependency,
  TaskNotFoundError,
  updateTask,
  transitionTask,
  VersionConflictError,
} from "./storage/tasks.ts";
import {
  DATABASE_ENVIRONMENT_VARIABLE,
  NotInitializedError,
  resolveDatabasePath,
} from "./storage/path.ts";
import {
  TASK_LIMITS,
  isWellFormedUnicode,
  validateCreateTaskInput,
  validateTransitionInput,
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
export interface CliMetadata {
  readonly version: string;
}
type Command =
  | "init"
  | "create"
  | "get"
  | "list"
  | "update"
  | "claim"
  | "transition"
  | "reopen"
  | "history"
  | "export"
  | "dependency-add"
  | "dependency-remove"
  | "skill-install";
type Format = "json" | "text";
const COMMANDS: readonly Command[] = [
  "init",
  "create",
  "get",
  "list",
  "update",
  "claim",
  "transition",
  "reopen",
  "history",
  "export",
  "dependency-add",
  "dependency-remove",
  "skill-install",
];

const HELP_TEXT = `Usage: taskctl <command> [options]

Commands:
  init               Initialize the task database
  create             Create a task
  get                Get a task
  list               List tasks
  update             Update a task
  claim              Claim a task
  transition         Change a task status
  reopen             Reopen a task
  history            Show task history
  export             Export all task data
  dependency-add     Add a task dependency
  dependency-remove  Remove a task dependency
  skill install      Install the agent-tasks Skill in a project

Global options:
  --help             Show this help
  --version          Show the installed version

Use --db <path> with task and database commands to select a database.
`;

export function runCli(
  args: readonly string[],
  io: CliIo,
  metadata: CliMetadata = { version: "0.0.0" },
): CliResult {
  if (args.length === 1 && args[0] === "--help")
    return writeText(io, HELP_TEXT);
  if (args.length === 1 && args[0] === "--version")
    return writeText(io, `${metadata.version}\n`);
  const topLevelCommand = args[0] ?? null;
  if (topLevelCommand === null)
    return writeError(io, 2, "INVALID_ARGUMENT", "A command is required.", {});
  const command =
    topLevelCommand === "skill" ? "skill-install" : topLevelCommand;
  const commandArgs =
    topLevelCommand === "skill" ? args.slice(2) : args.slice(1);
  if (topLevelCommand === "skill" && args[1] !== "install") {
    const requested = args[1] === undefined ? "skill" : `skill ${args[1]}`;
    return writeError(
      io,
      2,
      "UNKNOWN_COMMAND",
      `Unknown command: ${requested}`,
      {
        command: requested,
      },
    );
  }
  if (
    !COMMANDS.includes(command as Command) ||
    (command === "skill-install" && topLevelCommand !== "skill")
  ) {
    return writeError(io, 2, "UNKNOWN_COMMAND", `Unknown command: ${command}`, {
      command,
    });
  }
  try {
    const parsed = parseOptions(command as Command, commandArgs);
    const format = parseFormat(parsed.values.get("--format"));
    if (
      format === "text" &&
      command !== "get" &&
      command !== "list" &&
      command !== "history"
    ) {
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
      case "skill-install": {
        const projectRoot = resolveSkillProjectRoot(
          parsed.values.get("--project"),
          io.cwd ?? process.cwd(),
        );
        return writeSuccess(io, installSkill(projectRoot));
      }
      case "create": {
        const input = validateCreateTaskInput(readJson(parsed, io));
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeSuccess(io, createTask(dbPath, input));
      }
      case "get": {
        const taskId = requiredIdentifier(parsed, "--id");
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeOutput(io, "get", format, getTask(dbPath, taskId));
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
          "list",
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
      case "claim": {
        const taskId = requiredIdentifier(parsed, "--id");
        const agent = requiredIdentifier(parsed, "--agent");
        const expectedVersion = requiredInteger(
          parsed,
          "--expected-version",
          1,
        );
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeSuccess(
          io,
          claimTask(dbPath, taskId, agent, expectedVersion),
        );
      }
      case "transition": {
        const taskId = requiredIdentifier(parsed, "--id");
        const to = requiredEnum(parsed, "--to", TASK_STATUSES) as TaskStatus;
        const agent = requiredIdentifier(parsed, "--agent");
        const expectedVersion = requiredInteger(
          parsed,
          "--expected-version",
          1,
        );
        const input = validateTransitionInput(
          to,
          parsed.values.has("--input-json") ? readJson(parsed, io) : undefined,
        );
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeSuccess(
          io,
          transitionTask(dbPath, taskId, to, agent, expectedVersion, input),
        );
      }
      case "reopen": {
        const taskId = requiredIdentifier(parsed, "--id");
        const agent = requiredIdentifier(parsed, "--agent");
        const expectedVersion = requiredInteger(
          parsed,
          "--expected-version",
          1,
        );
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeSuccess(
          io,
          reopenTask(dbPath, taskId, agent, expectedVersion),
        );
      }
      case "history": {
        const taskId = requiredIdentifier(parsed, "--id");
        const limit = optionalInteger(parsed, "--limit", 100, 1, 500);
        const cursor = parsed.values.get("--cursor");
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeOutput(
          io,
          "history",
          format,
          getTaskHistory(dbPath, taskId, limit, cursor),
        );
      }
      case "export": {
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        return writeSuccess(io, exportTasks(dbPath));
      }
      case "dependency-add":
      case "dependency-remove": {
        const taskId = requiredIdentifier(parsed, "--id");
        const dependsOn = requiredIdentifier(parsed, "--depends-on");
        const expectedVersion = requiredInteger(
          parsed,
          "--expected-version",
          1,
        );
        const dbPath = databasePath(command, parsed.values.get("--db"), io);
        const changeDependency =
          command === "dependency-add"
            ? addTaskDependency
            : removeTaskDependency;
        return writeSuccess(
          io,
          changeDependency(dbPath, taskId, dependsOn, expectedVersion),
        );
      }
    }
  } catch (error) {
    if (error instanceof CliFailure)
      return writeError(io, 2, error.code, error.message, error.details);
    if (error instanceof DomainError)
      return writeError(
        io,
        error.code === "STATE_CONFLICT" ? 4 : 2,
        error.code,
        error.message,
        error.details,
      );
    if (error instanceof CursorInvalidError)
      return writeError(io, 2, error.code, error.message, error.details);
    if (
      error instanceof NotInitializedError ||
      error instanceof TaskNotFoundError ||
      error instanceof DependencyNotFoundError
    ) {
      return writeError(io, 3, error.code, error.message, error.details);
    }
    if (
      error instanceof VersionConflictError ||
      error instanceof NotRunnableError ||
      error instanceof DependencyConflictError ||
      error instanceof SkillConflictError
    )
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
  claim: ["--db", "--format", "--id", "--agent", "--expected-version"],
  transition: [
    "--db",
    "--format",
    "--id",
    "--to",
    "--agent",
    "--expected-version",
    "--input-json",
  ],
  reopen: ["--db", "--format", "--id", "--agent", "--expected-version"],
  history: ["--db", "--format", "--id", "--limit", "--cursor"],
  export: ["--db", "--format"],
  "dependency-add": [
    "--db",
    "--format",
    "--id",
    "--depends-on",
    "--expected-version",
  ],
  "dependency-remove": [
    "--db",
    "--format",
    "--id",
    "--depends-on",
    "--expected-version",
  ],
  "skill-install": ["--project", "--format"],
};
const FLAG_OPTIONS: Readonly<Record<Command, readonly string[]>> = {
  init: [],
  create: [],
  get: [],
  update: [],
  claim: [],
  transition: [],
  reopen: [],
  history: [],
  export: [],
  "dependency-add": [],
  "dependency-remove": [],
  "skill-install": [],
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
    if (value === undefined || value.length === 0) {
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
  if (typeof error !== "object" || error === null || !("code" in error))
    return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
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
    value.trim().length === 0 ||
    !isWellFormedUnicode(value)
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
function requiredEnum(
  options: ParsedOptions,
  name: string,
  allowed: readonly string[],
): string {
  const value = options.values.get(name);
  if (value === undefined)
    throw invalidArgument(name, undefined, "A required option is missing.");
  if (!allowed.includes(value))
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
function writeOutput(
  io: CliIo,
  command: "get" | "list" | "history",
  format: Format,
  data: object,
): CliResult {
  if (format === "json") return writeSuccess(io, data);
  io.writeStdout(formatText(command, data));
  return { exitCode: 0 };
}

function formatText(command: "get" | "list" | "history", data: object): string {
  if (command === "get") {
    const result = data as ReturnType<typeof getTask>;
    const task = result.task;
    return [
      `ID: ${escapeTextField(task.id)}`,
      `Title: ${escapeTextField(task.title)}`,
      `Status: ${escapeTextField(task.status)}`,
      `Priority: ${escapeTextField(task.priority)}`,
      `Assignee: ${escapeTextField(task.assignee ?? "-")}`,
      `Runnable: ${task.runnable ? "yes" : "no"}`,
      `Depends on: ${
        result.dependsOn.length === 0
          ? "-"
          : result.dependsOn.map(escapeTextField).join(", ")
      }`,
      `Description: ${escapeTextField(task.description || "-")}`,
      "",
    ].join("\n");
  }
  if (command === "list") {
    const result = data as ReturnType<typeof listTasks>;
    const rows = result.tasks.map((task) =>
      [
        escapeTextField(task.id),
        escapeTextField(task.status),
        escapeTextField(task.priority),
        escapeTextField(task.assignee ?? "-"),
        task.runnable ? "yes" : "no",
        escapeTextField(task.title),
      ].join("\t"),
    );
    return [
      "ID\tSTATUS\tPRIORITY\tASSIGNEE\tRUNNABLE\tTITLE",
      ...rows,
      ...(result.nextCursor === null
        ? []
        : [`Next cursor: ${escapeTextField(result.nextCursor)}`]),
      "",
    ].join("\n");
  }
  const result = data as ReturnType<typeof getTaskHistory>;
  const rows = result.events.map((event) =>
    [
      escapeTextField(event.occurredAt),
      escapeTextField(event.type),
      escapeTextField(event.actor ?? "-"),
      `${event.fromVersion ?? "-"}->${event.toVersion}`,
      escapeTextField(JSON.stringify(event.details)),
    ].join("\t"),
  );
  return [
    "OCCURRED_AT\tTYPE\tACTOR\tVERSION\tDETAILS",
    ...rows,
    ...(result.nextCursor === null
      ? []
      : [`Next cursor: ${escapeTextField(result.nextCursor)}`]),
    "",
  ].join("\n");
}

function escapeTextField(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f)) {
      escaped += character;
      continue;
    }
    if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (character === "\b") escaped += "\\b";
    else if (character === "\f") escaped += "\\f";
    else {
      const hexadecimal = codePoint.toString(16).toUpperCase().padStart(4, "0");
      escaped += `\\u{${hexadecimal}}`;
    }
  }
  return escaped;
}
function writeSuccess(io: CliIo, data: object): CliResult {
  io.writeStdout(`${JSON.stringify({ ok: true, data })}\n`);
  return { exitCode: 0 };
}
function writeText(io: CliIo, value: string): CliResult {
  io.writeStdout(value);
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
