import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ALLOWED_TRANSITIONS,
  assertAllowedTransition,
  assertCanReopen,
  deriveTransitionPatch,
} from "../src/domain/transition.ts";
import type { Task, TaskStatus } from "../src/domain/task.ts";
import { DomainError } from "../src/errors.ts";

void describe("task state transitions", () => {
  const allowedPairs: readonly (readonly [TaskStatus, TaskStatus])[] = [
    ["pending", "in_progress"],
    ["pending", "blocked"],
    ["pending", "canceled"],
    ["in_progress", "pending"],
    ["in_progress", "blocked"],
    ["in_progress", "done"],
    ["in_progress", "canceled"],
    ["blocked", "pending"],
    ["blocked", "canceled"],
  ];

  for (const [from, to] of allowedPairs) {
    void test(`allows ${from} -> ${to}`, () => {
      assert.doesNotThrow(() => assertAllowedTransition(from, to));
    });
  }

  void test("rejects an invalid transition with a structured error", () => {
    assert.throws(
      () => assertAllowedTransition("done", "pending"),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, "STATE_CONFLICT");
        assert.deepEqual(error.details, {
          actualStatus: "done",
          allowedStatuses: ALLOWED_TRANSITIONS.done,
        });
        return true;
      },
    );
  });

  void test("only reopens terminal statuses", () => {
    assert.doesNotThrow(() => assertCanReopen("done"));
    assert.doesNotThrow(() => assertCanReopen("canceled"));
    assert.throws(
      () => assertCanReopen("blocked"),
      (error: unknown) =>
        error instanceof DomainError && error.code === "STATE_CONFLICT",
    );
  });

  void test("derives the pending transition patch", () => {
    assert.deepEqual(
      deriveTransitionPatch(
        inProgressTask,
        "pending",
        "agent-next",
        undefined,
        occurredAt,
      ),
      {
        assignee: null,
        blockedReason: null,
        result: null,
        startedAt: null,
        completedAt: null,
      },
    );
  });

  void test("derives the in_progress transition patch", () => {
    assert.deepEqual(
      deriveTransitionPatch(
        {
          ...inProgressTask,
          status: "pending",
          assignee: null,
          startedAt: null,
        },
        "in_progress",
        "agent-next",
        undefined,
        occurredAt,
      ),
      {
        assignee: "agent-next",
        blockedReason: null,
        result: null,
        startedAt: occurredAt,
        completedAt: null,
      },
    );
  });

  void test("derives the blocked transition patch", () => {
    assert.deepEqual(
      deriveTransitionPatch(
        inProgressTask,
        "blocked",
        "agent-next",
        { blockedReason: "Waiting for review" },
        occurredAt,
      ),
      {
        assignee: inProgressTask.assignee,
        blockedReason: "Waiting for review",
        result: null,
        startedAt: inProgressTask.startedAt,
        completedAt: null,
      },
    );
  });

  void test("derives the done transition patch", () => {
    assert.deepEqual(
      deriveTransitionPatch(
        inProgressTask,
        "done",
        "agent-next",
        { result: "Implemented and tested" },
        occurredAt,
      ),
      {
        assignee: inProgressTask.assignee,
        blockedReason: null,
        result: "Implemented and tested",
        startedAt: inProgressTask.startedAt,
        completedAt: occurredAt,
      },
    );
  });

  void test("derives the canceled transition patch", () => {
    assert.deepEqual(
      deriveTransitionPatch(
        {
          ...inProgressTask,
          status: "blocked",
          blockedReason: "No capacity",
        },
        "canceled",
        "agent-next",
        undefined,
        occurredAt,
      ),
      {
        assignee: inProgressTask.assignee,
        blockedReason: null,
        result: null,
        startedAt: inProgressTask.startedAt,
        completedAt: occurredAt,
      },
    );
  });
});

const occurredAt = "2026-09-02T01:02:03.000Z";

const inProgressTask: Task = {
  id: "task-1",
  title: "Test task",
  description: "Test transition patches",
  status: "in_progress",
  priority: "normal",
  assignee: "agent-current",
  blockedReason: null,
  result: null,
  labels: [],
  metadata: {},
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  startedAt: "2026-09-01T01:00:00.000Z",
  completedAt: null,
  version: 3,
};
