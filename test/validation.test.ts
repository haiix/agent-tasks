import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DomainError, type ValidationIssue } from "../src/errors.ts";
import {
  TASK_LIMITS,
  validateCreateTaskInput,
  validateTask,
  validateTransitionInput,
  validateUpdateTaskInput,
} from "../src/validation/task.ts";

function validationIssues(run: () => unknown): readonly ValidationIssue[] {
  try {
    run();
  } catch (error: unknown) {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "VALIDATION_ERROR");
    const issues = error.details.issues;
    assert.ok(Array.isArray(issues));
    return issues as ValidationIssue[];
  }
  assert.fail("Expected validation to fail.");
}

function task(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "01JTEST",
    title: "Implement validation",
    description: "",
    status: "pending",
    priority: "normal",
    assignee: null,
    blockedReason: null,
    result: null,
    labels: [],
    metadata: {},
    createdAt: "2026-01-02T03:04:05.006Z",
    updatedAt: "2026-01-02T03:04:05.006Z",
    startedAt: null,
    completedAt: null,
    version: 1,
    ...overrides,
  };
}

void describe("create input validation", () => {
  void test("applies defaults and deterministic ordering", () => {
    assert.deepEqual(
      validateCreateTaskInput({
        title: "Implement parser",
        labels: ["😀", "z", "é"],
        dependsOn: ["task-b", "task-a"],
      }),
      {
        title: "Implement parser",
        description: "",
        priority: "normal",
        labels: ["z", "é", "😀"],
        metadata: {},
        dependsOn: ["task-a", "task-b"],
      },
    );
  });

  void test("rejects unknown fields, blank titles, invalid enums, and duplicates", () => {
    const issues = validationIssues(() =>
      validateCreateTaskInput({
        title: "   ",
        priority: "critical",
        labels: ["cli", "cli"],
        status: "done",
      }),
    );
    assert.deepEqual(
      issues.map(({ path, code }) => ({ path, code })),
      [
        { path: "labels[1]", code: "duplicate" },
        { path: "priority", code: "enum" },
        { path: "status", code: "unknown_field" },
        { path: "title", code: "blank" },
      ],
    );
  });

  void test("counts Unicode code points when enforcing title length", () => {
    assert.doesNotThrow(() =>
      validateCreateTaskInput({
        title: "😀".repeat(TASK_LIMITS.titleCharacters),
      }),
    );
    const issues = validationIssues(() =>
      validateCreateTaskInput({
        title: "😀".repeat(TASK_LIMITS.titleCharacters + 1),
      }),
    );
    assert.equal(issues[0]?.code, "too_long");
  });

  void test("rejects isolated UTF-16 surrogates", () => {
    const issues = validationIssues(() =>
      validateCreateTaskInput({
        title: "Invalid \ud800",
        description: "Invalid \udfff",
      }),
    );
    assert.deepEqual(
      issues.map(({ path, code }) => ({ path, code })),
      [
        { path: "description", code: "unicode" },
        { path: "title", code: "unicode" },
      ],
    );
  });

  void test("rejects oversized and non-JSON metadata", () => {
    const oversized = validationIssues(() =>
      validateCreateTaskInput({
        title: "Task",
        metadata: { value: "x".repeat(TASK_LIMITS.metadataBytes) },
      }),
    );
    assert.equal(
      oversized.some(({ code }) => code === "too_large"),
      true,
    );

    const nonFinite = validationIssues(() =>
      validateCreateTaskInput({ title: "Task", metadata: { value: Infinity } }),
    );
    assert.deepEqual(nonFinite[0], {
      path: "metadata.value",
      code: "finite",
      message: "Number must be finite.",
    });
  });
});

void describe("update and transition input validation", () => {
  void test("requires at least one update field", () => {
    assert.equal(
      validationIssues(() => validateUpdateTaskInput({}))[0]?.code,
      "required",
    );
  });

  void test("preserves only supplied update fields", () => {
    assert.deepEqual(validateUpdateTaskInput({ priority: "high" }), {
      priority: "high",
    });
  });

  void test("requires the destination-specific transition payload", () => {
    assert.deepEqual(
      validateTransitionInput("blocked", { blockedReason: "Waiting" }),
      {
        blockedReason: "Waiting",
      },
    );
    assert.deepEqual(
      validateTransitionInput("done", { result: "Passed tests" }),
      {
        result: "Passed tests",
      },
    );
    assert.equal(validateTransitionInput("canceled", undefined), undefined);
    assert.equal(
      validationIssues(() => validateTransitionInput("blocked", {}))[0]?.path,
      "blockedReason",
    );
    assert.equal(
      validationIssues(() => validateTransitionInput("pending", {}))[0]?.code,
      "unexpected",
    );
  });
});

void describe("stored task validation", () => {
  void test("accepts valid lifecycle shapes", () => {
    const startedAt = "2026-01-02T03:05:05.006Z";
    const completedAt = "2026-01-02T03:06:05.006Z";
    const updatedAt = completedAt;

    const values = [
      task(),
      task({ status: "blocked", blockedReason: "Waiting" }),
      task({
        status: "in_progress",
        assignee: "agent-a",
        startedAt,
        updatedAt,
      }),
      task({
        status: "blocked",
        assignee: "agent-a",
        blockedReason: "Waiting",
        startedAt,
        updatedAt,
      }),
      task({
        status: "done",
        assignee: "agent-a",
        result: "Passed tests",
        startedAt,
        completedAt,
        updatedAt,
      }),
      task({ status: "canceled", completedAt, updatedAt }),
      task({
        status: "canceled",
        assignee: "agent-a",
        startedAt,
        completedAt,
        updatedAt,
      }),
    ];

    for (const value of values) assert.doesNotThrow(() => validateTask(value));
  });

  void test("rejects inconsistent lifecycle fields", () => {
    const issues = validationIssues(() =>
      validateTask(task({ status: "done", result: "Done" })),
    );
    assert.deepEqual(
      issues.map(({ path, code }) => ({ path, code })),
      [
        { path: "assignee", code: "state" },
        { path: "completedAt", code: "state" },
        { path: "startedAt", code: "state" },
      ],
    );
  });

  void test("rejects invalid and out-of-order timestamps", () => {
    const invalid = validationIssues(() =>
      validateTask(task({ createdAt: "2026-02-30T03:04:05.006Z" })),
    );
    assert.equal(invalid[0]?.code, "datetime");

    const outOfOrder = validationIssues(() =>
      validateTask(
        task({
          createdAt: "2026-01-02T03:04:05.006Z",
          updatedAt: "2026-01-02T03:03:05.006Z",
        }),
      ),
    );
    assert.equal(
      outOfOrder.some(({ code }) => code === "order"),
      true,
    );
  });

  void test("rejects unknown and missing persisted fields", () => {
    const value = task({ runnable: true });
    delete value.version;
    const issues = validationIssues(() => validateTask(value));
    assert.deepEqual(
      issues.map(({ path, code }) => ({ path, code })),
      [
        { path: "runnable", code: "unknown_field" },
        { path: "version", code: "required" },
        { path: "version", code: "integer" },
      ],
    );
  });
});
