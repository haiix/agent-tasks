import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";

import { runCli } from "../src/main.ts";
import { claimTask } from "../src/storage/tasks.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void describe("task lifecycle commands", () => {
  void test("claims, transitions, reopens, and returns event history", () => {
    const fixture = initializedDatabase();
    const created = fixture.create("Lifecycle");
    const taskId = created.data.task.id as string;

    const claimed = fixture.run([
      "claim",
      "--id",
      taskId,
      "--agent",
      "agent-a",
      "--expected-version",
      "1",
    ]);
    assert.deepEqual(pickLifecycle(claimed.data.task), {
      status: "in_progress",
      assignee: "agent-a",
      blockedReason: null,
      result: null,
      version: 2,
    });
    assert.equal(claimed.data.task.startedAt, claimed.data.task.updatedAt);

    const blocked = fixture.run([
      "transition",
      "--id",
      taskId,
      "--to",
      "blocked",
      "--agent",
      "agent-a",
      "--expected-version",
      "2",
      "--input-json",
      JSON.stringify({ blockedReason: "Waiting for review" }),
    ]);
    assert.equal(blocked.data.task.status, "blocked");
    assert.equal(blocked.data.task.blockedReason, "Waiting for review");

    const resumed = fixture.run([
      "transition",
      "--id",
      taskId,
      "--to",
      "pending",
      "--agent",
      "agent-a",
      "--expected-version",
      "3",
    ]);
    assert.equal(resumed.data.task.assignee, null);
    assert.equal(resumed.data.task.startedAt, null);

    fixture.run([
      "claim",
      "--id",
      taskId,
      "--agent",
      "agent-b",
      "--expected-version",
      "4",
    ]);
    const done = fixture.run([
      "transition",
      "--id",
      taskId,
      "--to",
      "done",
      "--agent",
      "agent-b",
      "--expected-version",
      "5",
      "--input-json",
      JSON.stringify({ result: "Tests passed" }),
    ]);
    assert.equal(done.data.task.result, "Tests passed");
    assert.equal(done.data.task.completedAt, done.data.task.updatedAt);

    const ordinaryReturn = fixture.run([
      "transition",
      "--id",
      taskId,
      "--to",
      "pending",
      "--agent",
      "agent-b",
      "--expected-version",
      "6",
    ]);
    assert.equal(ordinaryReturn.exitCode, 4);
    assert.equal(ordinaryReturn.error?.code, "STATE_CONFLICT");

    const reopened = fixture.run([
      "reopen",
      "--id",
      taskId,
      "--agent",
      "agent-c",
      "--expected-version",
      "6",
    ]);
    assert.deepEqual(pickLifecycle(reopened.data.task), {
      status: "pending",
      assignee: null,
      blockedReason: null,
      result: null,
      version: 7,
    });

    const history = fixture.run(["history", "--id", taskId]);
    assert.deepEqual(
      (history.data.events as Array<Record<string, unknown>>).map((event) => ({
        type: event.type,
        actor: event.actor,
        fromVersion: event.fromVersion,
        toVersion: event.toVersion,
      })),
      [
        { type: "created", actor: null, fromVersion: null, toVersion: 1 },
        { type: "claimed", actor: "agent-a", fromVersion: 1, toVersion: 2 },
        {
          type: "transitioned",
          actor: "agent-a",
          fromVersion: 2,
          toVersion: 3,
        },
        {
          type: "transitioned",
          actor: "agent-a",
          fromVersion: 3,
          toVersion: 4,
        },
        { type: "claimed", actor: "agent-b", fromVersion: 4, toVersion: 5 },
        {
          type: "transitioned",
          actor: "agent-b",
          fromVersion: 5,
          toVersion: 6,
        },
        { type: "reopened", actor: "agent-c", fromVersion: 6, toVersion: 7 },
      ],
    );

    const firstPage = fixture.run(["history", "--id", taskId, "--limit", "2"]);
    assert.equal((firstPage.data.events as readonly unknown[]).length, 2);
    assert.equal(typeof firstPage.data.nextCursor, "string");
    const secondPage = fixture.run([
      "history",
      "--id",
      taskId,
      "--limit",
      "2",
      "--cursor",
      firstPage.data.nextCursor as string,
    ]);
    assert.equal((secondPage.data.events as readonly unknown[]).length, 2);
    assert.notDeepEqual(firstPage.data.events, secondPage.data.events);

    const mismatchedLimit = fixture.run([
      "history",
      "--id",
      taskId,
      "--limit",
      "3",
      "--cursor",
      firstPage.data.nextCursor as string,
    ]);
    assert.equal(mismatchedLimit.exitCode, 2);
    assert.equal(mismatchedLimit.error?.code, "CURSOR_INVALID");

    const historyCursor = decodeTestCursor(firstPage.data.nextCursor as string);
    for (const invalidPayload of [
      { ...historyCursor, toVersion: 7 },
      { ...historyCursor, toVersion: 999 },
      { ...historyCursor, extra: true },
    ]) {
      const invalid = fixture.run([
        "history",
        "--id",
        taskId,
        "--limit",
        "2",
        "--cursor",
        encodeTestCursor(invalidPayload),
      ]);
      assert.equal(invalid.exitCode, 2);
      assert.equal(invalid.error?.code, "CURSOR_INVALID");
    }
  });

  void test("distinguishes version, state, assignee, and runnable conflicts", () => {
    const fixture = initializedDatabase();
    const dependency = fixture.create("Dependency");
    const task = fixture.create("Dependent", [
      dependency.data.task.id as string,
    ]);
    const taskId = task.data.task.id as string;
    const baseClaim = [
      "claim",
      "--id",
      taskId,
      "--agent",
      "agent-a",
      "--expected-version",
    ];

    const notRunnable = fixture.run([...baseClaim, "1"]);
    assert.equal(notRunnable.exitCode, 4);
    assert.deepEqual(notRunnable.error, {
      code: "NOT_RUNNABLE",
      message: "The task has incomplete dependencies and is not runnable.",
      details: {
        taskId,
        incompleteDependencyIds: [dependency.data.task.id],
      },
    });

    const independent = fixture.create("Independent");
    const independentId = independent.data.task.id as string;
    fixture.run([
      "claim",
      "--id",
      independentId,
      "--agent",
      "agent-a",
      "--expected-version",
      "1",
    ]);
    const stale = fixture.run([
      "claim",
      "--id",
      independentId,
      "--agent",
      "agent-b",
      "--expected-version",
      "1",
    ]);
    assert.equal(stale.error?.code, "VERSION_CONFLICT");

    const wrongState = fixture.run([
      "claim",
      "--id",
      independentId,
      "--agent",
      "agent-b",
      "--expected-version",
      "2",
    ]);
    assert.equal(wrongState.error?.code, "STATE_CONFLICT");
    assert.deepEqual(wrongState.error?.details, {
      taskId: independentId,
      actualStatus: "in_progress",
      allowedStatuses: ["pending"],
    });

    const wrongAgent = fixture.run([
      "transition",
      "--id",
      independentId,
      "--to",
      "blocked",
      "--agent",
      "agent-b",
      "--expected-version",
      "2",
      "--input-json",
      JSON.stringify({ blockedReason: "Waiting" }),
    ]);
    assert.equal(wrongAgent.error?.code, "STATE_CONFLICT");
  });

  void test("rolls back a task update when its event cannot be inserted", () => {
    const fixture = initializedDatabase();
    const task = fixture.create("Atomic");
    const taskId = task.data.task.id as string;
    const database = new DatabaseSync(fixture.dbPath);
    let existingEventId: string;
    try {
      existingEventId = (
        database
          .prepare("SELECT id FROM task_events WHERE task_id = ?")
          .get(taskId) as { id: string }
      ).id;
    } finally {
      database.close();
    }

    assert.throws(() =>
      claimTask(fixture.dbPath, taskId, "agent-a", 1, {
        generateId: () => existingEventId,
      }),
    );
    const unchanged = fixture.run(["get", "--id", taskId]);
    assert.deepEqual(pickLifecycle(unchanged.data.task), {
      status: "pending",
      assignee: null,
      blockedReason: null,
      result: null,
      version: 1,
    });
  });

  void test("allows exactly one of two concurrent claim processes to succeed", async () => {
    const fixture = initializedDatabase();
    const task = fixture.create("Concurrent");
    const taskId = task.data.task.id as string;
    const common = [
      "src/cli.ts",
      "claim",
      "--id",
      taskId,
      "--expected-version",
      "1",
      "--db",
      fixture.dbPath,
    ];

    const [first, second] = await Promise.all([
      runProcess([...common, "--agent", "agent-a"]),
      runProcess([...common, "--agent", "agent-b"]),
    ]);
    assert.deepEqual(
      [first.exitCode, second.exitCode].sort((left, right) => left - right),
      [0, 4],
    );
    assert.equal(first.stderr, "");
    assert.equal(second.stderr, "");
    assert.doesNotThrow(() => JSON.parse(first.stdout));
    assert.doesNotThrow(() => JSON.parse(second.stdout));
    const failed = first.exitCode === 0 ? second : first;
    assert.equal(failed.response.error?.code, "VERSION_CONFLICT");

    const history = fixture.run(["history", "--id", taskId]);
    assert.equal(
      (history.data.events as Array<Record<string, unknown>>).filter(
        (event) => event.type === "claimed",
      ).length,
      1,
    );
  });
});

function pickLifecycle(task: Record<string, unknown>): Record<string, unknown> {
  return {
    status: task.status,
    assignee: task.assignee,
    blockedReason: task.blockedReason,
    result: task.result,
    version: task.version,
  };
}

function decodeTestCursor(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function encodeTestCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

interface Captured {
  readonly exitCode: number;
  readonly data: Record<string, unknown> & {
    readonly task: Record<string, unknown>;
    readonly events?: readonly Record<string, unknown>[];
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
  };
}

function initializedDatabase(): {
  readonly dbPath: string;
  readonly run: (args: readonly string[]) => Captured;
  readonly create: (title: string, dependsOn?: readonly string[]) => Captured;
} {
  const directory = mkdtempSync(join(tmpdir(), "agent-tasks-lifecycle-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "tasks.sqlite");
  const run = (args: readonly string[]): Captured => {
    let stdout = "";
    const result = runCli([...args, "--db", dbPath], {
      cwd: directory,
      environment: {},
      writeStdout(value) {
        stdout += value;
      },
    });
    return {
      exitCode: result.exitCode,
      ...(JSON.parse(stdout) as Omit<Captured, "exitCode">),
    };
  };
  assert.equal(run(["init"]).exitCode, 0);
  return {
    dbPath,
    run,
    create: (title, dependsOn = []) =>
      run(["create", "--input-json", JSON.stringify({ title, dependsOn })]),
  };
}

function runProcess(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly response: Captured;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
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
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === null) {
        reject(new Error(`Child process terminated without a code: ${stderr}`));
        return;
      }
      resolve({
        exitCode,
        stdout,
        stderr,
        response: {
          exitCode,
          ...(JSON.parse(stdout) as Omit<Captured, "exitCode">),
        },
      });
    });
  });
}
