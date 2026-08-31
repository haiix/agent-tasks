import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";

import { runCli } from "../src/main.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void describe("create/get/update commands", () => {
  void test("creates and gets a task using the public JSON shape", () => {
    const fixture = initializedDatabase();
    const created = fixture.run([
      "create",
      "--input-json",
      JSON.stringify({ title: "Build CLI", labels: ["z", "api"] }),
    ]);

    assert.equal(created.exitCode, 0);
    assert.match(created.data.task.id as string, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(created.data.task, {
      id: created.data.task.id,
      title: "Build CLI",
      description: "",
      status: "pending",
      priority: "normal",
      assignee: null,
      blockedReason: null,
      result: null,
      labels: ["api", "z"],
      metadata: {},
      createdAt: created.data.task.createdAt,
      updatedAt: created.data.task.createdAt,
      startedAt: null,
      completedAt: null,
      version: 1,
      runnable: true,
    });
    assert.deepEqual(created.data.dependsOn, []);

    const fetched = fixture.run([
      "get",
      "--id",
      created.data.task.id as string,
    ]);
    assert.deepEqual(fetched.data, created.data);
  });

  void test("supports stdin input, dependencies, update events, and optimistic locking", () => {
    const fixture = initializedDatabase();
    const dependency = fixture.create({ title: "Dependency" });
    const created = fixture.run(
      ["create", "--input-json", "-"],
      JSON.stringify({
        title: "Dependent",
        dependsOn: [dependency.data.task.id],
      }),
    );
    assert.equal(created.data.task.runnable, false);
    assert.deepEqual(created.data.dependsOn, [dependency.data.task.id]);

    const updated = fixture.run([
      "update",
      "--id",
      created.data.task.id as string,
      "--expected-version",
      "1",
      "--input-json",
      JSON.stringify({ title: "Renamed", priority: "urgent" }),
    ]);
    assert.equal(updated.exitCode, 0);
    assert.equal(updated.data.task.title, "Renamed");
    assert.equal(updated.data.task.version, 2);

    const stale = fixture.run([
      "update",
      "--id",
      created.data.task.id as string,
      "--expected-version",
      "1",
      "--input-json",
      JSON.stringify({ title: "Stale" }),
    ]);
    assert.equal(stale.exitCode, 4);
    assert.deepEqual(stale.error, {
      code: "VERSION_CONFLICT",
      message: "Task was modified by another process.",
      details: {
        taskId: created.data.task.id,
        expectedVersion: 1,
        actualVersion: 2,
      },
    });

    const database = new DatabaseSync(fixture.dbPath);
    try {
      const events = database
        .prepare(
          "SELECT type, from_version, to_version FROM task_events WHERE task_id = ? ORDER BY to_version",
        )
        .all(created.data.task.id as string) as unknown as Array<
        Record<string, unknown>
      >;
      assert.deepEqual(
        events.map((event) => ({ ...event })),
        [
          { type: "created", from_version: null, to_version: 1 },
          { type: "updated", from_version: 1, to_version: 2 },
        ],
      );
    } finally {
      database.close();
    }
  });

  void test("rejects missing tasks, malformed JSON, and direct status updates", () => {
    const fixture = initializedDatabase();
    const missing = fixture.run(["get", "--id", "missing"]);
    assert.equal(missing.exitCode, 3);
    assert.equal(missing.error?.code, "TASK_NOT_FOUND");
    assert.deepEqual(missing.error?.details, { taskId: "missing" });

    const malformed = fixture.run(["create", "--input-json", "{"]);
    assert.equal(malformed.exitCode, 2);
    assert.equal(malformed.error?.code, "INVALID_JSON");

    const created = fixture.create({ title: "Immutable status" });
    const status = fixture.run([
      "update",
      "--id",
      created.data.task.id as string,
      "--expected-version",
      "1",
      "--input-json",
      JSON.stringify({ status: "done" }),
    ]);
    assert.equal(status.exitCode, 2);
    assert.equal(status.error?.code, "VALIDATION_ERROR");
    assert.deepEqual(status.error?.details.issues, [
      {
        path: "",
        code: "required",
        message: "At least one update field is required.",
      },
      { path: "status", code: "unknown_field", message: "Unknown field." },
    ]);
  });
});

void describe("list command", () => {
  void test("filters tasks and orders them deterministically by priority and stable keys", () => {
    const fixture = initializedDatabase();
    const normal = fixture.create({ title: "Normal", labels: ["cli"] });
    const low = fixture.create({
      title: "Low",
      priority: "low",
      labels: ["cli"],
    });
    const urgent = fixture.create({
      title: "Urgent",
      priority: "urgent",
      labels: ["other"],
    });

    const all = fixture.run(["list"]);
    assert.deepEqual(
      (all.data.tasks as Array<Record<string, unknown>>).map((task) => task.id),
      [urgent.data.task.id, normal.data.task.id, low.data.task.id],
    );
    const cli = fixture.run([
      "list",
      "--label",
      "cli",
      "--status",
      "pending",
      "--runnable",
    ]);
    assert.deepEqual(
      (cli.data.tasks as Array<Record<string, unknown>>).map((task) => task.id),
      [normal.data.task.id, low.data.task.id],
    );
  });

  void test("paginates without overlap and rejects cursor option mismatches", () => {
    const fixture = initializedDatabase();
    fixture.create({ title: "One" });
    fixture.create({ title: "Two" });
    fixture.create({ title: "Three" });

    const first = fixture.run(["list", "--limit", "2"]);
    assert.equal((first.data.tasks as unknown[]).length, 2);
    assert.equal(typeof first.data.nextCursor, "string");
    const second = fixture.run([
      "list",
      "--limit",
      "2",
      "--cursor",
      first.data.nextCursor as string,
    ]);
    assert.equal((second.data.tasks as unknown[]).length, 1);
    assert.equal(second.data.nextCursor, null);

    const mismatch = fixture.run([
      "list",
      "--limit",
      "1",
      "--cursor",
      first.data.nextCursor as string,
    ]);
    assert.equal(mismatch.exitCode, 2);
    assert.equal(mismatch.error?.code, "CURSOR_INVALID");
  });

  void test("rejects invalid filters and mutually exclusive assignment filters", () => {
    const fixture = initializedDatabase();
    const invalidStatus = fixture.run(["list", "--status", "ready"]);
    assert.equal(invalidStatus.error?.code, "INVALID_ARGUMENT");
    const conflicting = fixture.run([
      "list",
      "--assignee",
      "agent-a",
      "--unassigned",
    ]);
    assert.equal(conflicting.error?.code, "INVALID_ARGUMENT");
  });
});

interface Captured {
  readonly exitCode: number;
  readonly data: {
    readonly task: Record<string, unknown>;
    readonly dependsOn: readonly unknown[];
    readonly tasks: readonly Record<string, unknown>[];
    readonly nextCursor: unknown;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
  };
}

function initializedDatabase(): {
  readonly dbPath: string;
  readonly run: (args: readonly string[], stdin?: string) => Captured;
  readonly create: (input: Record<string, unknown>) => Captured;
} {
  const directory = mkdtempSync(join(tmpdir(), "agent-tasks-commands-"));
  temporaryDirectories.push(directory);
  const dbPath = join(directory, "tasks.sqlite");
  const run = (args: readonly string[], stdin?: string): Captured => {
    let stdout = "";
    const result = runCli([...args, "--db", dbPath], {
      cwd: directory,
      environment: {},
      ...(stdin === undefined ? {} : { readStdin: () => stdin }),
      writeStdout(value) {
        stdout += value;
      },
    });
    return {
      exitCode: result.exitCode,
      ...(JSON.parse(stdout) as Omit<Captured, "exitCode">),
    };
  };
  const initialized = runCli(["init", "--db", dbPath], {
    cwd: directory,
    environment: {},
    writeStdout() {},
  });
  assert.equal(initialized.exitCode, 0);
  return {
    dbPath,
    run,
    create: (input) => run(["create", "--input-json", JSON.stringify(input)]),
  };
}
