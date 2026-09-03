import { DomainError } from "../errors.ts";
import type { Task, TaskStatus, TransitionInput } from "./task.ts";

export type TransitionPatch = Pick<
  Task,
  "assignee" | "blockedReason" | "result" | "startedAt" | "completedAt"
>;

export const ALLOWED_TRANSITIONS = {
  pending: ["in_progress", "blocked", "canceled"],
  in_progress: ["pending", "blocked", "done", "canceled"],
  blocked: ["pending", "canceled"],
  done: [],
  canceled: [],
} as const satisfies Readonly<Record<TaskStatus, readonly TaskStatus[]>>;

export const REOPENABLE_STATUSES = ["done", "canceled"] as const;

/**
 * Verifies that a normal state transition is permitted by the task lifecycle.
 *
 * @throws {@link DomainError} with `STATE_CONFLICT` when the transition is not
 * allowed.
 */
export function assertAllowedTransition(
  from: TaskStatus,
  to: TaskStatus,
): void {
  const allowedStatuses: readonly TaskStatus[] = ALLOWED_TRANSITIONS[from];
  if (allowedStatuses.includes(to)) {
    return;
  }

  throw new DomainError(
    "STATE_CONFLICT",
    `Task cannot transition from ${from} to ${to}.`,
    { actualStatus: from, allowedStatuses },
  );
}

/**
 * Verifies that a terminal task may return to the pending state.
 *
 * @throws {@link DomainError} with `STATE_CONFLICT` when the task is not
 * reopenable.
 */
export function assertCanReopen(from: TaskStatus): void {
  if ((REOPENABLE_STATUSES as readonly TaskStatus[]).includes(from)) {
    return;
  }

  throw new DomainError(
    "STATE_CONFLICT",
    `Task cannot be reopened from ${from}.`,
    { actualStatus: from, allowedStatuses: REOPENABLE_STATUSES },
  );
}

/**
 * Derives the lifecycle fields for a transition without mutating the task.
 * The caller is responsible for validating that the transition and input are
 * allowed before applying the returned patch.
 */
export function deriveTransitionPatch(
  task: Task,
  destination: TaskStatus,
  agent: string,
  input: TransitionInput,
  occurredAt: string,
): TransitionPatch {
  if (destination === "pending") {
    return {
      assignee: null,
      blockedReason: null,
      result: null,
      startedAt: null,
      completedAt: null,
    };
  }
  if (destination === "in_progress") {
    return {
      assignee: agent,
      blockedReason: null,
      result: null,
      startedAt: occurredAt,
      completedAt: null,
    };
  }
  if (destination === "blocked") {
    return {
      assignee: task.assignee,
      blockedReason:
        input !== undefined && "blockedReason" in input
          ? input.blockedReason
          : null,
      result: null,
      startedAt: task.startedAt,
      completedAt: null,
    };
  }
  if (destination === "done") {
    return {
      assignee: task.assignee,
      blockedReason: null,
      result: input !== undefined && "result" in input ? input.result : null,
      startedAt: task.startedAt,
      completedAt: occurredAt,
    };
  }
  return {
    assignee: task.assignee,
    blockedReason: null,
    result: null,
    startedAt: task.startedAt,
    completedAt: occurredAt,
  };
}
