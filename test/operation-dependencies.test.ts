import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { initializeDatabase } from "../src/storage/database.ts";
import {
  defaultOperationDependencies,
  type OperationDependencies,
  resolveOperationDependencies,
} from "../src/storage/operation-dependencies.ts";
import {
  addTaskDependency,
  claimTask,
  createTask,
  getTaskHistory,
  removeTaskDependency,
  reopenTask,
  transitionTask,
  updateTask,
} from "../src/storage/tasks.ts";
import {
  cleanupTemporaryDirectories,
  createTemporaryDirectory,
} from "./support/temporary-directory.ts";

afterEach(cleanupTemporaryDirectories);

void describe("storage operation dependencies", () => {
  void test("fills omitted dependency overrides from the shared defaults", () => {
    const now = (): string => "2026-09-02T00:00:00.000Z";
    const generateId = (): string => "fixed-id";

    const withNow = resolveOperationDependencies({ now });
    const withGenerateId = resolveOperationDependencies({ generateId });

    assert.equal(withNow.now, now);
    assert.equal(withNow.generateId, defaultOperationDependencies.generateId);
    assert.equal(withGenerateId.now, defaultOperationDependencies.now);
    assert.equal(withGenerateId.generateId, generateId);
  });

  void test("uses one deterministic timestamp and id source per write operation", () => {
    const directory = createTemporaryDirectory("agent-tasks-dependencies-");
    const dbPath = join(directory, "tasks.sqlite");
    initializeDatabase(dbPath);
    const dependency = createTask(dbPath, taskInput("Dependency"));

    let nowCalls = 0;
    const operationDependencies = (
      timestamp: string,
      ids: readonly string[],
    ): Partial<OperationDependencies> => {
      const remainingIds = [...ids];
      return {
        now: () => {
          nowCalls += 1;
          return timestamp;
        },
        generateId: () => {
          const id = remainingIds.shift();
          assert.notEqual(id, undefined);
          return id as string;
        },
      };
    };

    const created = createTask(
      dbPath,
      taskInput("Target"),
      operationDependencies("2026-09-02T00:00:01.000Z", [
        "target-id",
        "created-event-id",
      ]),
    );
    assert.equal(created.task.createdAt, "2026-09-02T00:00:01.000Z");
    assert.equal(created.task.updatedAt, created.task.createdAt);

    const updated = updateTask(
      dbPath,
      created.task.id,
      1,
      { title: "Updated target" },
      operationDependencies("2026-09-02T00:00:02.000Z", ["updated-event-id"]),
    );
    assert.equal(updated.task.updatedAt, "2026-09-02T00:00:02.000Z");

    const added = addTaskDependency(
      dbPath,
      created.task.id,
      dependency.task.id,
      2,
      operationDependencies("2026-09-02T00:00:03.000Z", [
        "dependency-added-event-id",
      ]),
    );
    assert.equal(added.task.updatedAt, "2026-09-02T00:00:03.000Z");

    const removed = removeTaskDependency(
      dbPath,
      created.task.id,
      dependency.task.id,
      3,
      operationDependencies("2026-09-02T00:00:04.000Z", [
        "dependency-removed-event-id",
      ]),
    );
    assert.equal(removed.task.updatedAt, "2026-09-02T00:00:04.000Z");

    const claimed = claimTask(
      dbPath,
      created.task.id,
      "agent-a",
      4,
      operationDependencies("2026-09-02T00:00:05.000Z", ["claimed-event-id"]),
    );
    assert.equal(claimed.task.startedAt, "2026-09-02T00:00:05.000Z");
    assert.equal(claimed.task.updatedAt, claimed.task.startedAt);

    const transitioned = transitionTask(
      dbPath,
      created.task.id,
      "done",
      "agent-a",
      5,
      { result: "Complete" },
      operationDependencies("2026-09-02T00:00:06.000Z", [
        "transitioned-event-id",
      ]),
    );
    assert.equal(transitioned.task.completedAt, "2026-09-02T00:00:06.000Z");
    assert.equal(transitioned.task.updatedAt, transitioned.task.completedAt);

    const reopened = reopenTask(
      dbPath,
      created.task.id,
      "agent-a",
      6,
      operationDependencies("2026-09-02T00:00:07.000Z", ["reopened-event-id"]),
    );
    assert.equal(reopened.task.updatedAt, "2026-09-02T00:00:07.000Z");
    assert.equal(nowCalls, 7);

    const history = getTaskHistory(dbPath, created.task.id, 10);
    assert.deepEqual(
      history.events.map(({ id, occurredAt }) => ({ id, occurredAt })),
      [
        {
          id: "created-event-id",
          occurredAt: "2026-09-02T00:00:01.000Z",
        },
        {
          id: "updated-event-id",
          occurredAt: "2026-09-02T00:00:02.000Z",
        },
        {
          id: "dependency-added-event-id",
          occurredAt: "2026-09-02T00:00:03.000Z",
        },
        {
          id: "dependency-removed-event-id",
          occurredAt: "2026-09-02T00:00:04.000Z",
        },
        {
          id: "claimed-event-id",
          occurredAt: "2026-09-02T00:00:05.000Z",
        },
        {
          id: "transitioned-event-id",
          occurredAt: "2026-09-02T00:00:06.000Z",
        },
        {
          id: "reopened-event-id",
          occurredAt: "2026-09-02T00:00:07.000Z",
        },
      ],
    );
  });
});

function taskInput(title: string) {
  return {
    title,
    description: "",
    priority: "normal" as const,
    labels: [],
    metadata: {},
    dependsOn: [],
  };
}
