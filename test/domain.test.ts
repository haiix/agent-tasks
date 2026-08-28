import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ALLOWED_TRANSITIONS,
  assertAllowedTransition,
  assertCanReopen,
} from "../src/domain/transition.ts";
import type { TaskStatus } from "../src/domain/task.ts";
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
});
