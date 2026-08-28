import { DomainError } from "../errors.ts";
import type { TaskStatus } from "./task.ts";

export const ALLOWED_TRANSITIONS = {
  pending: ["in_progress", "blocked", "canceled"],
  in_progress: ["pending", "blocked", "done", "canceled"],
  blocked: ["pending", "canceled"],
  done: [],
  canceled: [],
} as const satisfies Readonly<Record<TaskStatus, readonly TaskStatus[]>>;

export const REOPENABLE_STATUSES = ["done", "canceled"] as const;

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
