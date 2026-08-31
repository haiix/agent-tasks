import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { StorageError, type StorageErrorCode } from "../errors.ts";
import {
  executeMigration,
  type Migration,
  MIGRATIONS,
  migrationChecksum,
  SCHEMA_MIGRATIONS_SQL,
} from "./migrations.ts";

export const BUSY_TIMEOUT_MS = 5_000;
export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

interface MigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export interface InitializeDatabaseResult {
  readonly schemaVersion: number;
  readonly created: boolean;
}

export interface MigrationOptions {
  readonly migrations?: readonly Migration[];
  readonly now?: () => string;
}

export function initializeDatabase(
  dbPath: string,
  options: MigrationOptions = {},
): InitializeDatabaseResult {
  let created = false;
  let database: DatabaseSync | undefined;

  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    created = createDatabaseFile(dbPath);
    database = new DatabaseSync(dbPath);
    configureConnection(database);
    const schemaVersion = applyMigrations(database, dbPath, options);
    return { schemaVersion, created };
  } catch (error) {
    throw toStorageError(error, dbPath);
  } finally {
    database?.close();
  }
}

function createDatabaseFile(dbPath: string): boolean {
  try {
    closeSync(openSync(dbPath, "wx"));
    return true;
  } catch (error) {
    if (getErrorCode(error) === "EEXIST") return false;
    throw error;
  }
}

export function configureConnection(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA journal_mode = WAL");
}

export function applyMigrations(
  database: DatabaseSync,
  dbPath: string,
  options: MigrationOptions = {},
): number {
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? (() => new Date().toISOString());

  validateMigrationDefinitions(migrations, dbPath);
  runTransaction(database, () => {
    database.exec(SCHEMA_MIGRATIONS_SQL);
    validateAppliedMigrations(database, migrations, dbPath);

    for (const migration of migrations) {
      const existing = getMigration(database, migration.version);
      if (existing !== undefined) {
        validateMigrationRow(existing, migration, dbPath);
        continue;
      }

      executeMigration(database, migration);
      database
        .prepare(
          `INSERT INTO schema_migrations
            (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.name,
          migrationChecksum(migration),
          now(),
        );
    }
  });

  return migrations.at(-1)?.version ?? 0;
}

function validateMigrationDefinitions(
  migrations: readonly Migration[],
  dbPath: string,
): void {
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1 || migration.name.length === 0) {
      throw new StorageError(
        "DB_INVALID",
        "Migration definitions are invalid.",
        dbPath,
      );
    }
  }
}

function validateAppliedMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[],
  dbPath: string,
): void {
  const rows = database
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all() as unknown as MigrationRow[];

  for (const [index, row] of rows.entries()) {
    if (row.version !== index + 1) {
      throw new StorageError(
        "DB_INVALID",
        "The migration history is not contiguous.",
        dbPath,
      );
    }
    const migration = migrations[index];
    if (migration === undefined) {
      throw new StorageError(
        "SCHEMA_VERSION_UNSUPPORTED",
        "The database schema is newer than this application supports.",
        dbPath,
      );
    }
    validateMigrationRow(row, migration, dbPath);
  }
}

export function verifyDatabaseSchema(
  database: DatabaseSync,
  dbPath: string,
): void {
  try {
    validateAppliedMigrations(database, MIGRATIONS, dbPath);
    if (getMigration(database, LATEST_SCHEMA_VERSION) === undefined) {
      throw new StorageError(
        "DB_INVALID",
        "The database schema is not initialized to the required version.",
        dbPath,
      );
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      "DB_INVALID",
      "The database schema is invalid.",
      dbPath,
      error,
    );
  }
}

function validateMigrationRow(
  row: MigrationRow,
  migration: Migration,
  dbPath: string,
): void {
  if (
    row.name !== migration.name ||
    row.checksum !== migrationChecksum(migration)
  ) {
    throw new StorageError(
      "DB_INVALID",
      "An applied migration does not match the expected definition.",
      dbPath,
    );
  }
}

function getMigration(
  database: DatabaseSync,
  version: number,
): MigrationRow | undefined {
  return database
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = ?",
    )
    .get(version) as unknown as MigrationRow | undefined;
}

function runTransaction(database: DatabaseSync, operation: () => void): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

export function toStorageError(error: unknown, dbPath: string): StorageError {
  if (error instanceof StorageError) return error;
  const sqliteCode = getErrorCode(error);
  const sqliteErrorNumber = getSqlitePrimaryErrorNumber(error);
  let code: StorageErrorCode = "STORAGE_ERROR";
  let message = "A storage operation failed.";

  if (sqliteCode === "ERR_INVALID_STATE") {
    code = "STORAGE_ERROR";
  } else if (
    sqliteErrorNumber === 5 ||
    sqliteErrorNumber === 6 ||
    sqliteCode.startsWith("SQLITE_BUSY") ||
    sqliteCode.startsWith("SQLITE_LOCKED")
  ) {
    code = "DB_BUSY";
    message = "The database remained busy beyond the configured timeout.";
  } else if (
    sqliteErrorNumber === 11 ||
    sqliteErrorNumber === 26 ||
    sqliteCode.startsWith("SQLITE_CORRUPT") ||
    sqliteCode.startsWith("SQLITE_NOTADB")
  ) {
    code = "DB_INVALID";
    message = "The database file is invalid or corrupt.";
  }

  return new StorageError(code, message, dbPath, error);
}

function getSqlitePrimaryErrorNumber(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("errcode" in error)) {
    return undefined;
  }
  return typeof error.errcode === "number" ? error.errcode & 0xff : undefined;
}

function getErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "";
  }
  return typeof error.code === "string" ? error.code : "";
}
