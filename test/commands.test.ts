import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";

import { runCli } from "../src/main.ts";
import {
  createCliFixture,
  type Captured as BaseCaptured,
} from "./support/cli-fixture.ts";
import { cleanupTemporaryDirectories } from "./support/temporary-directory.ts";

afterEach(cleanupTemporaryDirectories);

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

  void test("accepts option values that start with --", () => {
    const fixture = initializedDatabase();
    const created = fixture.create({
      title: "Option-like values",
      labels: ["--label-name"],
    });
    const taskId = created.data.task.id as string;

    const claimed = fixture.run([
      "claim",
      "--id",
      taskId,
      "--agent",
      "--worker",
      "--expected-version",
      "1",
    ]);
    const listed = fixture.run(["list", "--label", "--label-name"]);

    assert.equal(claimed.exitCode, 0);
    assert.equal(claimed.data.task.assignee, "--worker");
    assert.deepEqual(
      (listed.data.tasks as Array<Record<string, unknown>>).map(
        (task) => task.id,
      ),
      [taskId],
    );
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

    const dependency = fixture.create({ title: "Dependency" });
    const dependent = fixture.create({
      title: "Dependent",
      dependsOn: [dependency.data.task.id],
    });
    const invalidDependencyId = "x".repeat(201);
    const dependencyDatabase = new DatabaseSync(fixture.dbPath);
    try {
      dependencyDatabase.exec("PRAGMA foreign_keys = OFF");
      dependencyDatabase
        .prepare(
          "UPDATE task_dependencies SET depends_on = ? WHERE task_id = ?",
        )
        .run(invalidDependencyId, dependent.data.task.id as string);
    } finally {
      dependencyDatabase.close();
    }

    const invalidDependency = fixture.run([
      "get",
      "--id",
      dependent.data.task.id as string,
    ]);
    assert.equal(invalidDependency.exitCode, 5);
    assert.deepEqual(invalidDependency.error, {
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

void describe("history, export, and text output", () => {
  void test("exports a stable snapshot ordered by task and dependency id", () => {
    const fixture = initializedDatabase();
    const dependency = fixture.create({ title: "Dependency" });
    const dependent = fixture.create({
      title: "Dependent",
      dependsOn: [dependency.data.task.id],
    });

    const exported = fixture.run(["export"]);
    const tasks = exported.data.tasks;
    const dependencies = exported.data.dependencies;

    assert.equal(exported.data.schemaVersion, 1);
    assert.match(
      exported.data.exportedAt as string,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      [...tasks.map((task) => task.id)].sort(),
    );
    assert.equal(
      tasks.every((task) => typeof task.runnable === "boolean"),
      true,
    );
    assert.deepEqual(dependencies, [
      {
        taskId: dependent.data.task.id,
        dependsOn: dependency.data.task.id,
      },
    ]);
  });

  void test("renders minimal text for get, list, and history", () => {
    const fixture = initializedDatabase();
    const created = fixture.create({ title: "Readable task" });
    const taskId = created.data.task.id as string;

    const get = runRaw(fixture.dbPath, [
      "get",
      "--id",
      taskId,
      "--format",
      "text",
    ]);
    const list = runRaw(fixture.dbPath, ["list", "--format", "text"]);
    const history = runRaw(fixture.dbPath, [
      "history",
      "--id",
      taskId,
      "--format",
      "text",
    ]);

    assert.equal(get.exitCode, 0);
    assert.match(get.stdout, new RegExp(`^ID: ${taskId}`, "m"));
    assert.match(get.stdout, /^Title: Readable task$/m);
    assert.match(
      list.stdout,
      /^ID\tSTATUS\tPRIORITY\tASSIGNEE\tRUNNABLE\tTITLE$/m,
    );
    assert.match(list.stdout, /\tpending\tnormal\t-\tyes\tReadable task$/m);
    assert.match(
      history.stdout,
      /^OCCURRED_AT\tTYPE\tACTOR\tVERSION\tDETAILS$/m,
    );
    assert.match(history.stdout, /\tcreated\t-\t-->1\t/);
    assert.equal(get.stdout.startsWith("{"), false);
  });

  void test("escapes control characters in every text output", () => {
    const fixture = initializedDatabase();
    const created = fixture.create({
      title: "Line\nTabbed\t\u001b[31mC1\u0085end",
      description: "carriage\rreturn\u0000",
      metadata: { note: "CSI\u009b31m" },
    });
    const taskId = created.data.task.id as string;
    fixture.run([
      "claim",
      "--id",
      taskId,
      "--agent",
      "agent\u001b[2J\tfake",
      "--expected-version",
      "1",
    ]);

    const get = runRaw(fixture.dbPath, [
      "get",
      "--id",
      taskId,
      "--format",
      "text",
    ]);
    const list = runRaw(fixture.dbPath, ["list", "--format", "text"]);
    const history = runRaw(fixture.dbPath, [
      "history",
      "--id",
      taskId,
      "--format",
      "text",
    ]);

    assert.match(
      get.stdout,
      /^Title: Line\\nTabbed\\t\\u\{001B\}\[31mC1\\u\{0085\}end$/m,
    );
    assert.match(get.stdout, /^Description: carriage\\rreturn\\u\{0000\}$/m);
    assert.match(
      list.stdout,
      /\tagent\\u\{001B\}\[2J\\tfake\tno\tLine\\nTabbed/,
    );
    assert.match(history.stdout, /\tagent\\u\{001B\}\[2J\\tfake\t1->2\t/);
    assert.match(history.stdout, /CSI\\u\{009B\}31m/);
    for (const output of [get.stdout, list.stdout, history.stdout]) {
      assert.equal(hasUnsafeControlCharacter(output), false);
    }
  });

  void test("keeps errors as JSON when text output is requested", () => {
    const fixture = initializedDatabase();
    const result = runRaw(fixture.dbPath, [
      "get",
      "--id",
      "missing",
      "--format",
      "text",
    ]);

    assert.equal(result.exitCode, 3);
    assert.equal(JSON.parse(result.stdout).error.code, "TASK_NOT_FOUND");
  });

  void test("reports invalid stored history events as DB_INVALID", () => {
    const corruptions: readonly Readonly<{
      name: string;
      values: Readonly<Record<string, string | number | null>>;
    }>[] = [
      {
        name: "timestamp",
        values: { occurred_at: "2026-01-02T03:04:05Z" },
      },
      {
        name: "unsafe version",
        values: {
          type: "updated",
          from_version: 9_007_199_254_740_991,
          to_version: 9_007_199_254_740_992,
          details_json: JSON.stringify({
            changes: { title: { from: "before", to: "after" } },
          }),
        },
      },
      {
        name: "history version gap",
        values: {
          type: "updated",
          from_version: 5,
          to_version: 6,
          details_json: JSON.stringify({
            changes: { title: { from: "before", to: "after" } },
          }),
        },
      },
      { name: "blank id", values: { id: " " } },
      { name: "blank actor", values: { actor: " " } },
      { name: "unexpected actor", values: { actor: "agent-a" } },
      {
        name: "missing actor",
        values: {
          type: "transitioned",
          actor: null,
          from_version: 1,
          to_version: 2,
          details_json: JSON.stringify({
            fromStatus: "pending",
            toStatus: "blocked",
            blockedReason: "blocked",
            result: null,
          }),
        },
      },
      {
        name: "created details",
        values: { details_json: JSON.stringify({ task: {}, dependsOn: [] }) },
      },
      {
        name: "updated details",
        values: {
          type: "updated",
          from_version: 1,
          to_version: 2,
          details_json: JSON.stringify({
            changes: { status: { from: "pending", to: "done" } },
          }),
        },
      },
      {
        name: "dependency details",
        values: {
          type: "dependencyAdded",
          from_version: 1,
          to_version: 2,
          details_json: JSON.stringify({ dependsOn: "" }),
        },
      },
      {
        name: "claimed details",
        values: {
          type: "claimed",
          actor: "agent-a",
          from_version: 1,
          to_version: 2,
          details_json: JSON.stringify({
            fromStatus: "pending",
            toStatus: "in_progress",
            assignee: "agent-b",
          }),
        },
      },
      {
        name: "transitioned details",
        values: {
          type: "transitioned",
          actor: "agent-a",
          from_version: 1,
          to_version: 2,
          details_json: JSON.stringify({
            fromStatus: "pending",
            toStatus: "done",
            blockedReason: null,
            result: "done",
          }),
        },
      },
      {
        name: "reopened details",
        values: {
          type: "reopened",
          actor: "agent-a",
          from_version: 1,
          to_version: 2,
          details_json: JSON.stringify({
            fromStatus: "blocked",
            toStatus: "pending",
          }),
        },
      },
    ];

    for (const corruption of corruptions) {
      const fixture = initializedDatabase();
      const created = fixture.create({ title: `Corrupt ${corruption.name}` });
      const taskId = created.data.task.id as string;
      const database = new DatabaseSync(fixture.dbPath);
      try {
        database.exec("PRAGMA ignore_check_constraints = ON");
        const assignments = Object.keys(corruption.values)
          .map((column) => `${column} = ?`)
          .join(", ");
        database
          .prepare(`UPDATE task_events SET ${assignments} WHERE task_id = ?`)
          .run(...Object.values(corruption.values), taskId);
      } finally {
        database.close();
      }

      for (const args of [
        ["history", "--id", taskId],
        ["history", "--id", taskId, "--format", "text"],
      ] as const) {
        const result = runRaw(fixture.dbPath, args);
        assert.equal(result.exitCode, 5, corruption.name);
        assert.deepEqual(
          JSON.parse(result.stdout).error,
          {
            code: "DB_INVALID",
            message: "Stored task data is invalid.",
            details: { dbPath: fixture.dbPath },
          },
          corruption.name,
        );
      }
    }
  });

  void test("reports causally inconsistent stored history as DB_INVALID", () => {
    const fixture = initializedDatabase();
    const created = fixture.create({ title: "Causal history" });
    const taskId = created.data.task.id as string;
    fixture.run([
      "claim",
      "--id",
      taskId,
      "--agent",
      "agent-a",
      "--expected-version",
      "1",
    ]);
    fixture.run([
      "transition",
      "--id",
      taskId,
      "--to",
      "done",
      "--agent",
      "agent-a",
      "--expected-version",
      "2",
      "--input-json",
      JSON.stringify({ result: "done" }),
    ]);

    const database = new DatabaseSync(fixture.dbPath);
    try {
      database
        .prepare(
          "UPDATE task_events SET details_json = ? WHERE task_id = ? AND to_version = 3",
        )
        .run(
          JSON.stringify({
            fromStatus: "pending",
            toStatus: "canceled",
            blockedReason: null,
            result: null,
          }),
          taskId,
        );
    } finally {
      database.close();
    }

    const result = fixture.run(["history", "--id", taskId]);
    assert.equal(result.exitCode, 5);
    assert.equal(result.error?.code, "DB_INVALID");
  });

  void test("reports history that disagrees with the stored task status", () => {
    const fixture = initializedDatabase();
    const created = fixture.create({ title: "Stored status" });
    const taskId = created.data.task.id as string;
    fixture.run([
      "transition",
      "--id",
      taskId,
      "--to",
      "canceled",
      "--agent",
      "agent-a",
      "--expected-version",
      "1",
    ]);

    const database = new DatabaseSync(fixture.dbPath);
    try {
      database
        .prepare(
          "UPDATE tasks SET status = 'pending', completed_at = NULL WHERE id = ?",
        )
        .run(taskId);
    } finally {
      database.close();
    }

    const result = fixture.run(["history", "--id", taskId]);
    assert.equal(result.exitCode, 5);
    assert.equal(result.error?.code, "DB_INVALID");
  });

  void test("orders same-millisecond events by causal version", () => {
    const fixture = initializedDatabase();
    const created = fixture.create({ title: "Same timestamp" });
    const taskId = created.data.task.id as string;
    fixture.run([
      "update",
      "--id",
      taskId,
      "--expected-version",
      "1",
      "--input-json",
      JSON.stringify({ title: "Updated" }),
    ]);

    const database = new DatabaseSync(fixture.dbPath);
    try {
      const occurredAt = database
        .prepare(
          "SELECT occurred_at AS occurredAt FROM task_events WHERE task_id = ? AND type = 'created'",
        )
        .get(taskId)?.occurredAt as string;
      database
        .prepare(
          `UPDATE task_events SET occurred_at = ?, id = CASE type
           WHEN 'created' THEN 'z-event' ELSE 'a-event' END WHERE task_id = ?`,
        )
        .run(occurredAt, taskId);
    } finally {
      database.close();
    }

    const history = fixture.run(["history", "--id", taskId]);
    assert.deepEqual(
      (history.data.events as Array<Record<string, unknown>>).map(
        (event) => event.type,
      ),
      ["created", "updated"],
    );
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

  void test("rejects malformed and stale list cursor positions", () => {
    const fixture = initializedDatabase();
    fixture.create({ title: "One" });
    fixture.create({ title: "Two" });

    const first = fixture.run(["list", "--limit", "1"]);
    const cursor = first.data.nextCursor as string;
    const payload = decodeTestCursor(cursor);
    const invalidPayloads = [
      { ...payload, rank: 999 },
      { ...payload, createdAt: "not-a-time" },
      { ...payload, id: " " },
      { ...payload, id: "x".repeat(201) },
      { ...payload, id: "\ud800" },
      { ...payload, id: "missing-task" },
      { ...payload, extra: true },
    ];

    for (const invalidPayload of invalidPayloads) {
      const result = fixture.run([
        "list",
        "--limit",
        "1",
        "--cursor",
        encodeTestCursor(invalidPayload),
      ]);
      assert.equal(result.exitCode, 2);
      assert.equal(result.error?.code, "CURSOR_INVALID");
    }

    const updated = fixture.run([
      "update",
      "--id",
      payload.id as string,
      "--expected-version",
      "1",
      "--input-json",
      JSON.stringify({ priority: "low" }),
    ]);
    assert.equal(updated.exitCode, 0);
    const stale = fixture.run(["list", "--limit", "1", "--cursor", cursor]);
    assert.equal(stale.exitCode, 2);
    assert.equal(stale.error?.code, "CURSOR_INVALID");
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

type Captured = BaseCaptured<{
  readonly task: Record<string, unknown>;
  readonly dependsOn: readonly unknown[];
  readonly tasks: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
  readonly dependencies: readonly Record<string, unknown>[];
  readonly schemaVersion: unknown;
  readonly exportedAt: unknown;
  readonly nextCursor: unknown;
}>;

function runRaw(
  dbPath: string,
  args: readonly string[],
): { readonly exitCode: number; readonly stdout: string } {
  let stdout = "";
  const result = runCli([...args, "--db", dbPath], {
    environment: {},
    writeStdout(value) {
      stdout += value;
    },
  });
  return { exitCode: result.exitCode, stdout };
}

function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    if (character === "\n" || character === "\t") return false;
    const codePoint = character.charCodeAt(0);
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
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

function initializedDatabase(): {
  readonly dbPath: string;
  readonly run: (args: readonly string[], stdin?: string) => Captured;
  readonly create: (input: Record<string, unknown>) => Captured;
} {
  const fixture = createCliFixture<Captured["data"]>({
    prefix: "agent-tasks-commands-",
  });
  const run = (args: readonly string[], stdin?: string): Captured =>
    fixture.run(args, stdin === undefined ? {} : { stdin });
  return {
    dbPath: fixture.dbPath,
    run,
    create: (input) => run(["create", "--input-json", JSON.stringify(input)]),
  };
}
