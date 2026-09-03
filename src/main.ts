import { mapCliError } from "./cli/error-mapping.ts";
import { executeCommand, type CliIo } from "./cli/handlers.ts";
import { writeError, writeOutput, writeText } from "./cli/output.ts";
import { parseCliInput } from "./cli/parser.ts";
import { HELP_TEXT } from "./cli/spec.ts";

export type { CliIo } from "./cli/handlers.ts";

export interface CliResult {
  exitCode: number;
}

export interface CliMetadata {
  readonly version: string;
}

/**
 * Parses and executes one CLI invocation, converting parsing and command
 * failures into stable CLI responses. Output writer failures may escape.
 *
 * @param args - Arguments after the executable name.
 * @param io - The output and environment boundary used by command handlers.
 * @param metadata - Build metadata exposed by commands such as `--version`.
 * @returns The exit code that the caller should assign to the process.
 */
export function runCli(
  args: readonly string[],
  io: CliIo,
  metadata: CliMetadata = { version: "0.0.0" },
): CliResult {
  try {
    const input = parseCliInput(args);
    if (input.kind === "help") return writeText(io, HELP_TEXT);
    if (input.kind === "version") return writeText(io, `${metadata.version}\n`);

    const data = executeCommand(input.command, input.options, io);
    return writeOutput(io, input.command, input.format, data);
  } catch (error) {
    const mapped = mapCliError(error);
    return writeError(
      io,
      mapped.exitCode,
      mapped.code,
      mapped.message,
      mapped.details,
    );
  }
}
