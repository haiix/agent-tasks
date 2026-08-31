import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void describe("CLI process integration", () => {
  void test("runs the main lifecycle against a real database", async () => {
    const fixture = temporaryDatabase();
    await fixture.success(["init"]);
    const created = await fixture.success([
      "create",
      "--input-json",
      JSON.stringify({ title: "Integration task", labels: ["cli"] }),
    ]);
    const taskId = readString(readObject(created.data, "task"), "id");

    const listed = await fixture.success(["list", "--runnable"]);
    assert.equal(readArray(listed.data, "tasks").length, 1);
    await fixture.success([
      "update",
      "--id",
      taskId,
      "--expected-version",
      "1",
      "--input-json",
      JSON.stringify({ priority: "high" }),
    ]);
    await fixture.success([
      "claim",
      "--id",
      taskId,
      "--agent",
      "integration-agent",
      "--expected-version",
      "2",
    ]);
    await fixture.success([
      "transition",
      "--id",
      taskId,
      "--to",
      "done",
      "--agent",
      "integration-agent",
      "--expected-version",
      "3",
      "--input-json",
      JSON.stringify({ result: "verified" }),
    ]);
    const history = await fixture.success(["history", "--id", taskId]);
    assert.equal(readArray(history.data, "events").length, 4);
    const exported = await fixture.success(["export"]);
    assert.equal(readArray(exported.data, "tasks").length, 1);

    const missing = await fixture.run(["get", "--id", "missing"]);
    assert.equal(missing.exitCode, 3);
    assert.equal(missing.response.error?.code, "TASK_NOT_FOUND");
    const invalidJson = await fixture.run(["create", "--input-json", "{"]);
    assert.equal(invalidJson.exitCode, 2);
    assert.equal(invalidJson.response.error?.code, "INVALID_JSON");
  });

  void test(
    "returns JSON when another process holds the database write lock",
    { timeout: 15_000 },
    async () => {
      const fixture = temporaryDatabase();
      await fixture.success(["init"]);
      const locker = await holdWriteLock(fixture.dbPath);
      try {
        const result = await fixture.run([
          "create",
          "--input-json",
          JSON.stringify({ title: "Locked" }),
        ]);
        assert.equal(result.exitCode, 5);
        assert.equal(result.response.error?.code, "DB_BUSY");
      } finally {
        locker.kill();
        await new Promise<void>((resolve) => {
          locker.once("close", () => resolve());
        });
      }
    },
  );

  void test("returns JSON for a corrupt database", async () => {
    const fixture = temporaryDatabase();
    writeFileSync(fixture.dbPath, "not a sqlite database", "utf8");
    const result = await fixture.run(["init"]);
    assert.equal(result.exitCode, 5);
    assert.equal(result.response.error?.code, "DB_INVALID");
  });
});

interface CliResponse {
  readonly ok: boolean;
  readonly data: Record<string, unknown>;
  readonly error?: { readonly code: string };
}

interface ProcessResult {
  readonly exitCode: number;
  readonly response: CliResponse;
  readonly stdout: string;
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "agent-tasks-integration-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "tasks.sqlite");
  const run = (args: readonly string[]) =>
    runCliProcess([...args, "--db", dbPath], directory);
  return {
    dbPath,
    run,
    async success(args: readonly string[]): Promise<CliResponse> {
      const result = await run(args);
      assert.equal(result.exitCode, 0, result.stdout);
      assert.equal(result.response.ok, true);
      return result.response;
    },
  };
}

function runCliProcess(
  args: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === null) {
        reject(new Error(`CLI exited without a code: ${stderr}`));
        return;
      }
      assert.equal(stderr, "");
      const response = JSON.parse(stdout) as CliResponse;
      resolve({ exitCode, response, stdout });
    });
  });
}

function holdWriteLock(dbPath: string): Promise<ChildProcess> {
  const script = [
    'import { DatabaseSync } from "node:sqlite";',
    "const database = new DatabaseSync(process.argv[1]);",
    'database.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");',
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script, dbPath],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      reject(new Error(`Lock holder exited with ${exitCode}: ${stderr}`));
    });
    child.stdout?.once("data", (chunk: string) => {
      if (chunk.includes("ready")) resolve(child);
      else reject(new Error(`Unexpected lock holder output: ${chunk}`));
    });
  });
}

function readObject(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const result = value[key];
  assert.equal(typeof result, "object");
  assert.notEqual(result, null);
  assert.equal(Array.isArray(result), false);
  return result as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  assert.equal(typeof result, "string");
  return result as string;
}

function readArray(
  value: Record<string, unknown>,
  key: string,
): readonly unknown[] {
  const result = value[key];
  assert.equal(Array.isArray(result), true);
  return result as readonly unknown[];
}
