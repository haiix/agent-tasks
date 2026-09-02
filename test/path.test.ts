import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, test } from "node:test";

import { StorageError } from "../src/errors.ts";
import {
  NotInitializedError,
  resolveDatabasePath,
} from "../src/storage/path.ts";
import {
  cleanupTemporaryDirectories,
  createTemporaryDirectory,
} from "./support/temporary-directory.ts";

afterEach(cleanupTemporaryDirectories);

void describe("database path resolution", () => {
  void test("prefers --db over the environment and resolves it from cwd", () => {
    assert.equal(
      resolveDatabasePath({
        command: "init",
        cwd: "/work/project",
        explicitPath: "explicit/tasks.sqlite",
        environmentPath: "environment/tasks.sqlite",
        pathOperations: posix,
      }),
      "/work/project/explicit/tasks.sqlite",
    );
  });

  void test("uses the environment path when --db is absent", () => {
    assert.equal(
      resolveDatabasePath({
        command: "init",
        cwd: "/work/project",
        environmentPath: "../shared/tasks.sqlite",
        pathOperations: posix,
      }),
      "/work/shared/tasks.sqlite",
    );
  });

  void test("uses the current macOS-style directory for init without searching parents", () => {
    assert.equal(
      resolveDatabasePath({
        command: "init",
        cwd: "/Users/alice/project/packages/app",
        pathOperations: posix,
      }),
      "/Users/alice/project/packages/app/.agent-tasks/tasks.sqlite",
    );
  });

  void test("searches Linux-style parent directories for other commands", () => {
    const found = "/home/alice/project/.agent-tasks/tasks.sqlite";
    assert.equal(
      resolveDatabasePath({
        command: "list",
        cwd: "/home/alice/project/packages/app",
        pathOperations: posix,
        pathExists: (candidate) => candidate === found,
      }),
      found,
    );
  });

  void test("searches Windows-style parent directories to the drive root", () => {
    const found = "C:\\work\\project\\.agent-tasks\\tasks.sqlite";
    assert.equal(
      resolveDatabasePath({
        command: "get",
        cwd: "C:\\work\\project\\packages\\app",
        pathOperations: win32,
        pathExists: (candidate) => candidate === found,
      }),
      found,
    );
  });

  void test("skips a directory named tasks.sqlite and continues searching parents", () => {
    const root = createTemporaryDirectory("agent-tasks-path-");
    const project = join(root, "project");
    const child = join(project, "packages", "app");
    const childCandidate = join(child, ".agent-tasks", "tasks.sqlite");
    const parentCandidate = join(project, ".agent-tasks", "tasks.sqlite");

    mkdirSync(childCandidate, { recursive: true });
    mkdirSync(join(project, ".agent-tasks"), { recursive: true });
    closeSync(openSync(parentCandidate, "wx"));

    assert.equal(
      resolveDatabasePath({ command: "list", cwd: child }),
      parentCandidate,
    );
  });

  void test("returns NOT_INITIALIZED without creating a database", () => {
    assert.throws(
      () =>
        resolveDatabasePath({
          command: "list",
          cwd: "/work/project",
          pathOperations: posix,
          pathExists: () => false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof NotInitializedError);
        assert.equal(error.code, "NOT_INITIALIZED");
        assert.deepEqual(error.details, {
          dbPath: "/work/project/.agent-tasks/tasks.sqlite",
        });
        return true;
      },
    );
  });

  void test("does not report an inaccessible database path as uninitialized", () => {
    const dbPath = "/work/project/.agent-tasks/tasks.sqlite";
    assert.throws(
      () =>
        resolveDatabasePath({
          command: "list",
          cwd: "/work/project",
          explicitPath: dbPath,
          pathOperations: posix,
          pathExists() {
            throw new StorageError(
              "STORAGE_ERROR",
              "The database path could not be accessed.",
              dbPath,
            );
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, "STORAGE_ERROR");
        assert.deepEqual(error.details, { dbPath });
        return true;
      },
    );
  });
});
