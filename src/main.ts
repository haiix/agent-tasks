export interface CliIo {
  writeStdout(value: string): void;
}

export interface CliResult {
  exitCode: number;
}

export function runCli(args: readonly string[], io: CliIo): CliResult {
  const command = args[0] ?? null;
  const response = {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message:
        command === null
          ? "A command is required."
          : `Unknown command: ${command}`,
      details: command === null ? {} : { command },
    },
  };

  io.writeStdout(`${JSON.stringify(response)}\n`);
  return { exitCode: 2 };
}
