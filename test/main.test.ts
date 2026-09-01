import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../src/main.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("returns a machine-readable error when no command is provided", () => {
  let stdout = "";

  const result = runCli([], {
    writeStdout(value) {
      stdout += value;
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stdout.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(stdout), {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message: "A command is required.",
      details: {},
    },
  });
});

void test("reports an unknown command without throwing", () => {
  let stdout = "";

  const result = runCli(["unknown"], {
    writeStdout(value) {
      stdout += value;
    },
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(stdout), {
    ok: false,
    error: {
      code: "UNKNOWN_COMMAND",
      message: "Unknown command: unknown",
      details: { command: "unknown" },
    },
  });
});

void test("prints top-level help as human-readable text", () => {
  let stdout = "";

  const result = runCli(["--help"], {
    writeStdout(value) {
      stdout += value;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(stdout, /^Usage: taskctl <command> \[options\]/);
  assert.match(stdout, /dependency-remove/);
  assert.match(stdout, /skill install/);
  assert.equal(stdout.endsWith("\n"), true);
});

void test("prints the provided package version", () => {
  let stdout = "";

  const result = runCli(
    ["--version"],
    {
      writeStdout(value) {
        stdout += value;
      },
    },
    { version: "1.2.3" },
  );

  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(stdout, "1.2.3\n");
});

void test("validates command input before looking for a database", () => {
  const cwd = temporaryDirectory();
  const missingId = captureCli(["get"], cwd);
  const invalidJson = captureCli(["create", "--input-json", "{"], cwd);

  assert.equal(missingId.result.exitCode, 2);
  assert.equal(missingId.response.error.code, "INVALID_ARGUMENT");
  assert.deepEqual(missingId.response.error.details, { option: "--id" });
  assert.equal(invalidJson.result.exitCode, 2);
  assert.equal(invalidJson.response.error.code, "INVALID_JSON");
});

void test("initializes the default database and returns JSON", () => {
  const cwd = temporaryDirectory();
  let stdout = "";

  const result = runCli(["init"], {
    cwd,
    environment: {},
    writeStdout(value) {
      stdout += value;
    },
  });

  const dbPath = resolve(cwd, ".agent-tasks", "tasks.sqlite");
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(dbPath), true);
  assert.deepEqual(JSON.parse(stdout), {
    ok: true,
    data: { dbPath, schemaVersion: 1, created: true },
  });
});

void test("prefers --db and preserves an existing database on repeated init", () => {
  const cwd = temporaryDirectory();
  const explicitPath = join("explicit", "tasks.sqlite");
  const environmentPath = join("environment", "tasks.sqlite");

  const first = captureCli(
    ["init", "--db", explicitPath],
    cwd,
    environmentPath,
  );
  const second = captureCli(
    ["init", "--db", explicitPath],
    cwd,
    environmentPath,
  );

  assert.equal(first.result.exitCode, 0);
  assert.equal(first.response.data.created, true);
  assert.equal(second.result.exitCode, 0);
  assert.equal(second.response.data.created, false);
  assert.equal(second.response.data.dbPath, resolve(cwd, explicitPath));
  assert.equal(existsSync(resolve(cwd, environmentPath)), false);
});

void test("accepts a database path that starts with --", () => {
  const cwd = temporaryDirectory();
  const explicitPath = "--tasks.sqlite";
  const captured = captureCli(["init", "--db", explicitPath], cwd);

  assert.equal(captured.result.exitCode, 0);
  assert.equal(captured.response.data.dbPath, resolve(cwd, explicitPath));
  assert.equal(existsSync(resolve(cwd, explicitPath)), true);
});

void test("uses AGENT_TASKS_DB when --db is absent", () => {
  const cwd = temporaryDirectory();
  const environmentPath = join("environment", "tasks.sqlite");
  const captured = captureCli(["init"], cwd, environmentPath);

  assert.equal(captured.result.exitCode, 0);
  assert.equal(captured.response.data.dbPath, resolve(cwd, environmentPath));
});

void test("returns DB_INVALID for a non-SQLite database", () => {
  const cwd = temporaryDirectory();
  const dbPath = join(cwd, "invalid.sqlite");
  writeFileSync(dbPath, "not a sqlite database", "utf8");
  const captured = captureCli(["init", "--db", dbPath], cwd);

  assert.equal(captured.result.exitCode, 5);
  assert.deepEqual(captured.response, {
    ok: false,
    error: {
      code: "DB_INVALID",
      message: "The database file is invalid or corrupt.",
      details: { dbPath },
    },
  });
});

void test("rejects duplicate and unsupported init options", () => {
  const cwd = temporaryDirectory();
  const duplicate = captureCli(
    ["init", "--db", "one.sqlite", "--db", "two.sqlite"],
    cwd,
  );
  const text = captureCli(["init", "--format", "text"], cwd);

  assert.equal(duplicate.result.exitCode, 2);
  assert.equal(duplicate.response.error.code, "INVALID_ARGUMENT");
  assert.deepEqual(duplicate.response.error.details, { option: "--db" });
  assert.equal(text.result.exitCode, 2);
  assert.equal(text.response.error.code, "UNSUPPORTED_FORMAT");
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-tasks-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

function captureCli(
  args: readonly string[],
  cwd: string,
  environmentPath?: string,
): {
  readonly result: ReturnType<typeof runCli>;
  readonly response: CapturedResponse;
} {
  let stdout = "";
  const result = runCli(args, {
    cwd,
    environment:
      environmentPath === undefined ? {} : { AGENT_TASKS_DB: environmentPath },
    writeStdout(value) {
      stdout += value;
    },
  });
  return {
    result,
    response: JSON.parse(stdout) as unknown as CapturedResponse,
  };
}

interface CapturedResponse {
  readonly data: Readonly<Record<string, unknown>>;
  readonly error: {
    readonly code: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
}
