export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "canceled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type Priority = (typeof PRIORITIES)[number];

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: Priority;
  readonly assignee: string | null;
  readonly blockedReason: string | null;
  readonly result: string | null;
  readonly labels: readonly string[];
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly version: number;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly description: string;
  readonly priority: Priority;
  readonly labels: readonly string[];
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly dependsOn: readonly string[];
}

export interface UpdateTaskInput {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: Priority;
  readonly labels?: readonly string[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type TransitionInput =
  { readonly blockedReason: string } | { readonly result: string } | undefined;
