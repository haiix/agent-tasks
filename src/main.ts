import { StorageError } from "./errors.ts";
import { initializeDatabase } from "./storage/database.ts";
import {
  DATABASE_ENVIRONMENT_VARIABLE,
  NotInitializedError,
  resolveDatabasePath,
} from "./storage/path.ts";

export interface CliIo {
  writeStdout(value: string): void;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface CliResult {
  exitCode: number;
}

export function runCli(args: readonly string[], io: CliIo): CliResult {
  const command = args[0] ?? null;
  if (command === null) {
    return writeError(io, 2, "INVALID_ARGUMENT", "A command is required.", {});
  }
  if (command !== "init") {
    return writeError(io, 2, "UNKNOWN_COMMAND", `Unknown command: ${command}`, {
      command,
    });
  }

  try {
    const options = parseInitOptions(args.slice(1));
    if (options.format === "text") {
      return writeError(
        io,
        2,
        "UNSUPPORTED_FORMAT",
        "The init command does not support text output.",
        { format: "text" },
      );
    }

    const environment = io.environment ?? process.env;
    const dbPath = resolveDatabasePath({
      command,
      cwd: io.cwd ?? process.cwd(),
      ...(options.dbPath === undefined ? {} : { explicitPath: options.dbPath }),
      ...(environment[DATABASE_ENVIRONMENT_VARIABLE] === undefined
        ? {}
        : { environmentPath: environment[DATABASE_ENVIRONMENT_VARIABLE] }),
    });
    const result = initializeDatabase(dbPath);
    return writeSuccess(io, {
      dbPath,
      schemaVersion: result.schemaVersion,
      created: result.created,
    });
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      return writeError(io, 2, error.code, error.message, error.details);
    }
    if (error instanceof NotInitializedError) {
      return writeError(io, 3, error.code, error.message, error.details);
    }
    if (error instanceof StorageError) {
      return writeError(io, 5, error.code, error.message, error.details);
    }
    return writeError(
      io,
      5,
      "INTERNAL_ERROR",
      "An unexpected internal error occurred.",
      {},
    );
  }
}

interface InitOptions {
  readonly dbPath?: string;
  readonly format: "json" | "text";
}

class InvalidArgumentError extends Error {
  readonly code = "INVALID_ARGUMENT";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "InvalidArgumentError";
    this.details = details;
  }
}

function parseInitOptions(args: readonly string[]): InitOptions {
  let dbPath: string | undefined;
  let format: "json" | "text" = "json";
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (option !== "--db" && option !== "--format") {
      throw new InvalidArgumentError("Unknown option.", { option });
    }
    if (seen.has(option)) {
      throw new InvalidArgumentError(
        "An option was specified more than once.",
        {
          option,
        },
      );
    }
    seen.add(option);

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw new InvalidArgumentError("An option value is required.", {
        option,
      });
    }
    if (option === "--db") {
      dbPath = value;
    } else if (value === "json" || value === "text") {
      format = value;
    } else {
      throw new InvalidArgumentError("Invalid option value.", {
        option,
        value,
      });
    }
  }

  return { ...(dbPath === undefined ? {} : { dbPath }), format };
}

function writeSuccess(
  io: CliIo,
  data: Readonly<Record<string, unknown>>,
): CliResult {
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
