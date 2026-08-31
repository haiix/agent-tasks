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

  void test("reports a schema mismatch as DB_INVALID", () => {
    const fixture = initializedDatabase();
    const database = new DatabaseSync(fixture.dbPath);
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("DROP TABLE tasks");
    } finally {
      database.close();
    }

    const result = fixture.run(["get", "--id", "task-1"]);
    assert.equal(result.exitCode, 5);
    assert.equal(result.error?.code, "DB_INVALID");
    assert.deepEqual(result.error?.details, { dbPath: fixture.dbPath });
  });

  void test("reports invalid stored task data as DB_INVALID", () => {
    const fixture = initializedDatabase();
    const created = fixture.create({ title: "Stored task" });
    const database = new DatabaseSync(fixture.dbPath);
    try {
      database
        .prepare("UPDATE tasks SET labels_json = ? WHERE id = ?")
        .run(
          JSON.stringify(Array.from({ length: 51 }, (_, index) => `l${index}`)),
          created.data.task.id as string,
        );
    } finally {
      database.close();
    }

    const result = fixture.run(["get", "--id", created.data.task.id as string]);
    assert.equal(result.exitCode, 5);
    assert.deepEqual(result.error, {
      code: "DB_INVALID",
      message: "Stored task data is invalid.",
      details: { dbPath: fixture.dbPath },
    });
  });

  void test("rejects isolated UTF-16 surrogates before writing to SQLite", () => {
    const fixture = initializedDatabase();
    const result = fixture.run([
      "create",
      "--input-json",
      JSON.stringify({ title: "Invalid \ud800" }),
    ]);
    assert.equal(result.exitCode, 2);
    assert.deepEqual(result.error, {
      code: "VALIDATION_ERROR",
      message: "Input validation failed.",
      details: {
        issues: [
          {
            path: "title",
            code: "unicode",
            message: "Value must be well-formed Unicode.",
          },
        ],
      },
    });

    const database = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      assert.equal(
        database.prepare("SELECT count(*) AS count FROM tasks").get()?.count,
        0,
      );
    } finally {
      database.close();
    }
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

void describe("task dependencies", () => {
  void test("adds and removes dependencies with versioned events", () => {
    const fixture = initializedDatabase();
    const dependency = fixture.create({ title: "Dependency" });
    const dependent = fixture.create({ title: "Dependent" });

    const added = fixture.run([
      "dependency-add",
      "--id",
      dependent.data.task.id as string,
      "--depends-on",
      dependency.data.task.id as string,
      "--expected-version",
      "1",
    ]);
    assert.equal(added.exitCode, 0);
    assert.equal(added.data.task.version, 2);
    assert.equal(added.data.task.runnable, false);
    assert.deepEqual(added.data.dependsOn, [dependency.data.task.id]);

    const removed = fixture.run([
      "dependency-remove",
      "--id",
      dependent.data.task.id as string,
      "--depends-on",
      dependency.data.task.id as string,
      "--expected-version",
      "2",
    ]);
    assert.equal(removed.exitCode, 0);
    assert.equal(removed.data.task.version, 3);
    assert.equal(removed.data.task.runnable, true);
    assert.deepEqual(removed.data.dependsOn, []);

    const database = new DatabaseSync(fixture.dbPath);
    try {
      const events = database
        .prepare(
          "SELECT type, details_json FROM task_events WHERE task_id = ? ORDER BY to_version",
        )
        .all(dependent.data.task.id as string) as unknown as Array<
        Record<string, unknown>
      >;
      assert.deepEqual(
        events.map((event) => ({
          type: event.type,
          details: JSON.parse(event.details_json as string) as unknown,
        })),
        [
          { type: "created", details: dependent.data },
          {
            type: "dependencyAdded",
            details: { dependsOn: dependency.data.task.id },
          },
          {
            type: "dependencyRemoved",
            details: { dependsOn: dependency.data.task.id },
          },
        ],
      );
    } finally {
      database.close();
    }
  });

  void test("rejects self, duplicate, cyclic, missing, and stale changes", () => {
    const fixture = initializedDatabase();
    const first = fixture.create({ title: "First" });
    const second = fixture.create({
      title: "Second",
      dependsOn: [first.data.task.id],
    });
    const third = fixture.create({
      title: "Third",
      dependsOn: [second.data.task.id],
    });

    const conflicts = [
      {
        args: [first.data.task.id, first.data.task.id, "self"],
      },
      {
        args: [second.data.task.id, first.data.task.id, "duplicate"],
      },
      {
        args: [first.data.task.id, third.data.task.id, "cycle"],
      },
    ];
    for (const conflict of conflicts) {
      const [taskId, dependsOn, reason] = conflict.args as string[];
      const result = fixture.run([
        "dependency-add",
        "--id",
        taskId as string,
        "--depends-on",
        dependsOn as string,
        "--expected-version",
        "1",
      ]);
      assert.equal(result.exitCode, 4);
      assert.deepEqual(result.error, {
        code: "DEPENDENCY_CONFLICT",
        message: "The dependency conflicts with the existing dependency graph.",
        details: { taskId, dependsOn, reason },
      });
    }

    const missing = fixture.run([
      "dependency-remove",
      "--id",
      first.data.task.id as string,
      "--depends-on",
      second.data.task.id as string,
      "--expected-version",
      "1",
    ]);
    assert.equal(missing.exitCode, 3);
    assert.equal(missing.error?.code, "DEPENDENCY_NOT_FOUND");

    const stale = fixture.run([
      "dependency-remove",
      "--id",
      second.data.task.id as string,
      "--depends-on",
      first.data.task.id as string,
      "--expected-version",
      "2",
    ]);
    assert.equal(stale.exitCode, 4);
    assert.equal(stale.error?.code, "VERSION_CONFLICT");
  });

  void test("derives runnable across multiple levels and after reopening a dependency", () => {
    const fixture = initializedDatabase();
    const foundation = fixture.create({ title: "Foundation" });
    const middle = fixture.create({
      title: "Middle",
      dependsOn: [foundation.data.task.id],
    });
    const top = fixture.create({
      title: "Top",
      dependsOn: [middle.data.task.id],
    });

    assert.deepEqual(runnableIds(fixture.run(["list", "--runnable"])), [
      foundation.data.task.id,
    ]);

    const database = new DatabaseSync(fixture.dbPath);
    try {
      markDone(database, foundation.data.task.id as string);
      assert.deepEqual(runnableIds(fixture.run(["list", "--runnable"])), [
        middle.data.task.id,
      ]);
      markDone(database, middle.data.task.id as string);
      assert.deepEqual(runnableIds(fixture.run(["list", "--runnable"])), [
        top.data.task.id,
      ]);

      database
        .prepare(
          `UPDATE tasks SET status = 'pending', assignee = NULL, result = NULL,
           started_at = NULL, completed_at = NULL WHERE id = ?`,
        )
        .run(middle.data.task.id as string);
      assert.deepEqual(runnableIds(fixture.run(["list", "--runnable"])), [
        middle.data.task.id,
      ]);
      assert.equal(
        fixture.run(["get", "--id", top.data.task.id as string]).data.task
          .runnable,
        false,
      );
    } finally {
      database.close();
    }
  });
});

function runnableIds(result: Captured): readonly unknown[] {
  return (result.data.tasks as Array<Record<string, unknown>>).map(
    (task) => task.id,
  );
}

function markDone(database: DatabaseSync, taskId: string): void {
  database
    .prepare(
      `UPDATE tasks SET status = 'done', assignee = 'test-agent', result = 'done',
       started_at = created_at, completed_at = updated_at WHERE id = ?`,
    )
    .run(taskId);
}

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
