import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";

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
    } finally {
      database.close();
    }
  });

  void test("rolls back every statement in a failed migration", () => {
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
      assert.deepEqual(
        database
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => row.version),
        [1],
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
