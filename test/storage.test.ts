import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { Worker } from "node:worker_threads";

import { StorageError } from "../src/errors.ts";
import {
  applyMigrations,
  BUSY_TIMEOUT_MS,
  configureConnection,
  initializeDatabase,
  LATEST_SCHEMA_VERSION,
} from "../src/storage/database.ts";
import type { Migration } from "../src/storage/migrations.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void describe("SQLite storage", () => {
  void test("initializes an empty database at the latest schema", () => {
    const dbPath = temporaryDatabasePath(true);

    assert.deepEqual(initializeDatabase(dbPath), {
      schemaVersion: LATEST_SCHEMA_VERSION,
      created: true,
    });

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all()
        .map((row) => row.name);
      assert.deepEqual(tables, [
        "schema_migrations",
        "task_dependencies",
        "task_events",
        "tasks",
      ]);

      const migration = database
        .prepare(
          "SELECT version, name, length(checksum) AS checksum_length FROM schema_migrations",
        )
        .get();
      assert.equal(migration?.version, 1);
      assert.equal(migration?.name, "initial_schema");
      assert.equal(migration?.checksum_length, 64);
    } finally {
      database.close();
    }
  });

  void test("is idempotent and preserves existing data", () => {
    const dbPath = temporaryDatabasePath();
    const timestamp = "2026-08-31T00:00:00.000Z";
    initializeDatabase(dbPath);

    const database = new DatabaseSync(dbPath);
    try {
      database
        .prepare(
          `INSERT INTO tasks (
            id, title, description, status, priority, labels_json, metadata_json,
            created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "task-1",
          "Persist me",
          "",
          "pending",
          "normal",
          "[]",
          "{}",
          timestamp,
          timestamp,
          1,
        );
    } finally {
      database.close();
    }

    assert.deepEqual(initializeDatabase(dbPath), {
      schemaVersion: LATEST_SCHEMA_VERSION,
      created: false,
    });

    const verificationDatabase = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        verificationDatabase
          .prepare("SELECT count(*) AS count FROM tasks")
          .get()?.count,
        1,
      );
      assert.equal(
        verificationDatabase
          .prepare("SELECT count(*) AS count FROM schema_migrations")
          .get()?.count,
        1,
      );
    } finally {
      verificationDatabase.close();
    }
  });

  void test("configures locking and enforces schema constraints and indexes", () => {
    const dbPath = temporaryDatabasePath();
    initializeDatabase(dbPath);
    const database = new DatabaseSync(dbPath);

    try {
      configureConnection(database);
      assert.equal(
        database.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
        1,
      );
      assert.equal(
        database.prepare("PRAGMA busy_timeout").get()?.timeout,
        BUSY_TIMEOUT_MS,
      );
      assert.equal(
        database.prepare("PRAGMA journal_mode").get()?.journal_mode,
        "wal",
      );

      const timestamp = "2026-08-31T00:00:00.000Z";
      const insertTask = database.prepare(
        `INSERT INTO tasks (
          id, title, description, status, priority, labels_json, metadata_json,
          created_at, updated_at, version
        ) VALUES (?, ?, '', 'pending', 'normal', '[]', '{}', ?, ?, 1)`,
      );
      insertTask.run("task-1", "First", timestamp, timestamp);
      insertTask.run("task-2", "Second", timestamp, timestamp);
      insertTask.run("task-3", "Third", timestamp, timestamp);
      insertTask.run("task-4", "Fourth", timestamp, timestamp);
      const updatePriority = database.prepare(
        "UPDATE tasks SET priority = ? WHERE id = ?",
      );
      updatePriority.run("low", "task-1");
      updatePriority.run("urgent", "task-2");
      updatePriority.run("high", "task-3");

      const insertDependency = database.prepare(
        "INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)",
      );
      insertDependency.run("task-2", "task-1");
      assert.throws(() => insertDependency.run("task-2", "task-1"));
      assert.throws(() => insertDependency.run("task-1", "task-1"));
      assert.throws(() => insertDependency.run("task-1", "missing"));

      const indexes = database
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'index' AND name LIKE 'idx_%'
           ORDER BY name`,
        )
        .all()
        .map((row) => row.name);
      assert.deepEqual(indexes, [
        "idx_task_dependencies_depends_on",
        "idx_task_events_history",
        "idx_tasks_assignee",
        "idx_tasks_list_order",
        "idx_tasks_status",
      ]);

      const listOrderExpression = `CASE priority
        WHEN 'urgent' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        WHEN 'low' THEN 3
      END`;
      const queryPlan = database
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT id FROM tasks
           ORDER BY ${listOrderExpression}, created_at, id`,
        )
        .all();
      assert.equal(
        queryPlan.some(
          (row) =>
            typeof row.detail === "string" &&
            row.detail.includes("idx_tasks_list_order"),
        ),
        true,
      );
      assert.deepEqual(
        database
          .prepare(
            `SELECT id FROM tasks
             ORDER BY ${listOrderExpression}, created_at, id`,
          )
          .all()
          .map((row) => row.id),
        ["task-2", "task-3", "task-4", "task-1"],
      );
    } finally {
      database.close();
    }
  });

  void test("revalidates the full history after acquiring the write lock", async () => {
    const dbPath = temporaryDatabasePath();
    initializeDatabase(dbPath);
    const writer = new DatabaseSync(dbPath);
    configureConnection(writer);
    writer.exec("BEGIN IMMEDIATE");
    writer
      .prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(2, "future", "future-checksum", "2026-08-31T00:00:00.000Z");

    const databaseModuleUrl = new URL(
      "../src/storage/database.ts",
      import.meta.url,
    ).href;
    const worker = new Worker(
      `
        const { parentPort } = require("node:worker_threads");
        const { DatabaseSync } = require("node:sqlite");

        void (async () => {
          const { applyMigrations } = await import(${JSON.stringify(databaseModuleUrl)});
          parentPort.postMessage({ type: "ready" });
          parentPort.once("message", () => {
            const database = new DatabaseSync(${JSON.stringify(dbPath)});
            database.exec("PRAGMA busy_timeout = 5000");
            try {
              applyMigrations(database, ${JSON.stringify(dbPath)});
              parentPort.postMessage({ type: "result", code: null });
            } catch (error) {
              parentPort.postMessage({ type: "result", code: error.code ?? null });
            } finally {
              database.close();
            }
          });
        })();
      `,
      { eval: true },
    );

    try {
      assert.deepEqual(await nextWorkerMessage(worker), { type: "ready" });
      const result = nextWorkerMessage(worker);
      worker.postMessage({ type: "start" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      writer.exec("COMMIT");
      assert.deepEqual(await result, {
        type: "result",
        code: "SCHEMA_VERSION_UNSUPPORTED",
      });
    } finally {
      if (writer.isTransaction) writer.exec("ROLLBACK");
      writer.close();
      await worker.terminate();
    }
  });

  void test("rolls back all schema changes when a migration fails", () => {
    const dbPath = temporaryDatabasePath();
    const database = new DatabaseSync(dbPath);
    const migrations: readonly Migration[] = [
      {
        version: 1,
        name: "successful",
        statements: ["CREATE TABLE stable (id INTEGER PRIMARY KEY) STRICT"],
      },
      {
        version: 2,
        name: "fails",
        statements: [
          "CREATE TABLE must_be_rolled_back (id INTEGER PRIMARY KEY) STRICT",
          "THIS IS NOT SQL",
        ],
      },
    ];

    try {
      configureConnection(database);
      assert.throws(() =>
        applyMigrations(database, dbPath, {
          migrations,
          now: () => "2026-08-31T00:00:00.000Z",
        }),
      );
      assert.equal(
        database
          .prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = ?")
          .get("must_be_rolled_back")?.count,
        0,
      );
      assert.equal(
        database
          .prepare(
            "SELECT count(*) AS count FROM sqlite_schema WHERE name IN (?, ?)",
          )
          .get("stable", "schema_migrations")?.count,
        0,
      );
    } finally {
      database.close();
    }
  });

  void test("rejects unsupported and modified migration histories", () => {
    const unsupportedPath = temporaryDatabasePath();
    initializeDatabase(unsupportedPath);
    const unsupportedDatabase = new DatabaseSync(unsupportedPath);
    try {
      unsupportedDatabase
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(2, "future", "future-checksum", "2026-08-31T00:00:00.000Z");
    } finally {
      unsupportedDatabase.close();
    }
    assert.throws(
      () => initializeDatabase(unsupportedPath),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "SCHEMA_VERSION_UNSUPPORTED" &&
        error.details.dbPath === unsupportedPath,
    );

    const modifiedPath = temporaryDatabasePath();
    initializeDatabase(modifiedPath);
    const modifiedDatabase = new DatabaseSync(modifiedPath);
    try {
      modifiedDatabase
        .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?")
        .run("modified", 1);
    } finally {
      modifiedDatabase.close();
    }
    assert.throws(
      () => initializeDatabase(modifiedPath),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "DB_INVALID" &&
        error.details.dbPath === modifiedPath,
    );
  });

  void test("converts an invalid database file into a structured error", () => {
    const dbPath = temporaryDatabasePath();
    writeFileSync(dbPath, "not a sqlite database", "utf8");

    assert.throws(
      () => initializeDatabase(dbPath),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, "DB_INVALID");
        assert.deepEqual(error.details, { dbPath });
        assert.equal(error.cause instanceof Error, true);
        return true;
      },
    );
  });
});

function temporaryDatabasePath(nested = false): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-tasks-storage-"));
  temporaryDirectories.push(directory);
  return nested
    ? join(directory, "nested", "tasks.sqlite")
    : join(directory, "tasks.sqlite");
}

function nextWorkerMessage(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      worker.off("error", onError);
      resolve(message);
    };
    const onError = (error: Error): void => {
      worker.off("message", onMessage);
      reject(error);
    };
    worker.once("message", onMessage);
    worker.once("error", onError);
  });
}
