import assert from "node:assert/strict";
import { join } from "node:path";

import { runCli } from "../../src/main.ts";
import { createTemporaryDirectory } from "./temporary-directory.ts";

export interface Captured<
  Data extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
> {
  readonly exitCode: number;
  readonly ok: boolean;
  readonly data: Data;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
}

interface CliFixtureOptions {
  readonly prefix: string;
}

interface RunOptions {
  readonly stdin?: string;
}

export function createCliFixture<
  Data extends Readonly<Record<string, unknown>>,
>(
  options: CliFixtureOptions,
): {
  readonly directory: string;
  readonly dbPath: string;
  readonly run: (
    args: readonly string[],
    options?: RunOptions,
  ) => Captured<Data>;
} {
  const directory = createTemporaryDirectory(options.prefix);
  const dbPath = join(directory, "tasks.sqlite");
  const run = (args: readonly string[], runOptions: RunOptions = {}) =>
    captureCli<Data>([...args, "--db", dbPath], {
      cwd: directory,
      environment: {},
      ...(runOptions.stdin === undefined
        ? {}
        : { readStdin: () => runOptions.stdin ?? "" }),
    });

  assert.equal(run(["init"]).exitCode, 0);
  return { directory, dbPath, run };
}

export function captureCli<Data extends Readonly<Record<string, unknown>>>(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly readStdin?: () => string;
  } = {},
): Captured<Data> {
  const { result, response } = captureCliResponse<
    Omit<Captured<Data>, "exitCode">
  >(args, options);
  return { exitCode: result.exitCode, ...response };
}

export function captureCliResponse<Response>(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly readStdin?: () => string;
  } = {},
): {
  readonly result: ReturnType<typeof runCli>;
  readonly response: Response;
  readonly stdout: string;
} {
  let stdout = "";
  const result = runCli(args, {
    ...options,
    writeStdout(value) {
      stdout += value;
    },
  });
  return { result, response: JSON.parse(stdout) as Response, stdout };
}
