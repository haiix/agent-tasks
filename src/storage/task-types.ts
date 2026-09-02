import type { Priority, Task, TaskStatus } from "../domain/task.ts";
import type { ValidatedTaskEvent } from "../validation/task-event.ts";

export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: Priority;
  readonly assignee: string | null;
  readonly blocked_reason: string | null;
  readonly result: string | null;
  readonly labels_json: string;
  readonly metadata_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly version: number;
  readonly runnable: number;
}

export interface TaskEventRow {
  readonly id: string;
  readonly task_id: string;
  readonly type: string;
  readonly actor: string | null;
  readonly occurred_at: string;
  readonly from_version: number | null;
  readonly to_version: number;
  readonly details_json: string;
}

export interface TaskResult {
  readonly task: Task & { readonly runnable: boolean };
  readonly dependsOn: readonly string[];
}

export interface ListFilters {
  readonly status?: TaskStatus;
  readonly priority?: Priority;
  readonly assignee?: string;
  readonly unassigned: boolean;
  readonly label?: string;
  readonly runnable: boolean;
  readonly limit: number;
  readonly cursor?: string;
}

export interface ListResult {
  readonly tasks: readonly (Task & { readonly runnable: boolean })[];
  readonly nextCursor: string | null;
}

export type TaskEvent = ValidatedTaskEvent;

export interface HistoryResult {
  readonly events: readonly TaskEvent[];
  readonly nextCursor: string | null;
}

export interface TaskDependency {
  readonly taskId: string;
  readonly dependsOn: string;
}

export interface ExportResult {
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly tasks: readonly (Task & { readonly runnable: boolean })[];
  readonly dependencies: readonly TaskDependency[];
}
