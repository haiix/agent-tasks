import {
  TASK_STATUSES,
  type TaskStatus,
  type UpdateTaskInput,
} from "../domain/task.ts";
import {
  ALLOWED_TRANSITIONS,
  REOPENABLE_STATUSES,
} from "../domain/transition.ts";
import {
  TASK_LIMITS,
  isWellFormedUnicode,
  validateTask,
  validateTaskDependencies,
  validateUpdateTaskInput,
} from "./task.ts";

export const TASK_EVENT_TYPES = [
  "created",
  "updated",
  "dependencyAdded",
  "dependencyRemoved",
  "claimed",
  "transitioned",
  "reopened",
] as const;

export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export interface ValidatedTaskEvent {
  readonly id: string;
  readonly taskId: string;
  readonly type: TaskEventType;
  readonly actor: string | null;
  readonly occurredAt: string;
  readonly fromVersion: number | null;
  readonly toVersion: number;
  readonly details: Readonly<Record<string, unknown>>;
}

const RFC_3339_UTC_MILLISECONDS =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

const UPDATE_FIELDS = [
  "title",
  "description",
  "priority",
  "labels",
  "metadata",
] as const satisfies readonly (keyof UpdateTaskInput)[];

type UnknownRecord = Record<string, unknown>;

export function validateTaskEvent(value: unknown): ValidatedTaskEvent {
  const event = requireExactObject(value, [
    "id",
    "taskId",
    "type",
    "actor",
    "occurredAt",
    "fromVersion",
    "toVersion",
    "details",
  ]);
  const id = requireIdentifier(event.id);
  const taskId = requireIdentifier(event.taskId);
  const type = requireEventType(event.type);
  const actor = event.actor === null ? null : requireIdentifier(event.actor);
  validateActor(type, actor);
  const occurredAt = requireTimestamp(event.occurredAt);
  const { fromVersion, toVersion } = requireVersions(
    type,
    event.fromVersion,
    event.toVersion,
  );
  const details = validateDetails(type, event.details, {
    actor,
    taskId,
    occurredAt,
    toVersion,
  });

  return {
    id,
    taskId,
    type,
    actor,
    occurredAt,
    fromVersion,
    toVersion,
    details,
  };
}

export function validateTaskEventHistory(
  events: readonly ValidatedTaskEvent[],
  task: Readonly<{ readonly version: unknown; readonly status: unknown }>,
): void {
  const taskVersion = task.version;
  if (!Number.isSafeInteger(taskVersion) || (taskVersion as number) < 1) {
    throw new Error("Stored task version is invalid.");
  }
  const taskStatus = requireStatus(task.status);
  if (events.length === 0 || events.at(-1)?.toVersion !== taskVersion) {
    throw new Error("Event history does not reach the stored task version.");
  }
  let currentStatus: TaskStatus = "pending";
  for (const [index, event] of events.entries()) {
    if (event.toVersion !== index + 1) {
      throw new Error("Event history versions are not contiguous.");
    }
    if (
      event.type !== "claimed" &&
      event.type !== "transitioned" &&
      event.type !== "reopened"
    ) {
      continue;
    }
    const fromStatus = requireStatus(event.details.fromStatus);
    const toStatus = requireStatus(event.details.toStatus);
    if (fromStatus !== currentStatus) {
      throw new Error("Event history statuses are not causally contiguous.");
    }
    currentStatus = toStatus;
  }
  if (currentStatus !== taskStatus) {
    throw new Error("Event history does not reach the stored task status.");
  }
}

function validateDetails(
  type: TaskEventType,
  value: unknown,
  event: Readonly<{
    actor: string | null;
    taskId: string;
    occurredAt: string;
    toVersion: number;
  }>,
): Readonly<UnknownRecord> {
  switch (type) {
    case "created": {
      const details = requireExactObject(value, ["task", "dependsOn"]);
      const storedTask = requireExactObject(details.task, [
        "id",
        "title",
        "description",
        "status",
        "priority",
        "assignee",
        "blockedReason",
        "result",
        "labels",
        "metadata",
        "createdAt",
        "updatedAt",
        "startedAt",
        "completedAt",
        "version",
        "runnable",
      ]);
      const { runnable, ...taskValue } = storedTask;
      const task = validateTask(taskValue);
      const dependsOn = validateTaskDependencies(details.dependsOn);
      if (
        typeof runnable !== "boolean" ||
        task.id !== event.taskId ||
        task.status !== "pending" ||
        task.version !== event.toVersion ||
        task.createdAt !== event.occurredAt ||
        task.updatedAt !== event.occurredAt
      ) {
        throw new Error("Created event details are inconsistent.");
      }
      return { task: { ...task, runnable }, dependsOn };
    }
    case "updated": {
      const details = requireExactObject(value, ["changes"]);
      const changes = requireObject(details.changes);
      const fields = Object.keys(changes);
      if (
        fields.length === 0 ||
        fields.some(
          (field) => !(UPDATE_FIELDS as readonly string[]).includes(field),
        )
      ) {
        throw new Error("Updated event changes are invalid.");
      }
      const validatedChanges: UnknownRecord = {};
      for (const field of fields as (keyof UpdateTaskInput)[]) {
        const change = requireExactObject(changes[field], ["from", "to"]);
        const from = validateUpdateTaskInput({ [field]: change.from })[field];
        const to = validateUpdateTaskInput({ [field]: change.to })[field];
        validatedChanges[field] = { from, to };
      }
      return { changes: validatedChanges };
    }
    case "dependencyAdded":
    case "dependencyRemoved": {
      const details = requireExactObject(value, ["dependsOn"]);
      requireIdentifier(details.dependsOn);
      return details;
    }
    case "claimed": {
      const details = requireExactObject(value, [
        "fromStatus",
        "toStatus",
        "assignee",
      ]);
      const assignee = requireIdentifier(details.assignee);
      if (
        details.fromStatus !== "pending" ||
        details.toStatus !== "in_progress" ||
        event.actor === null ||
        assignee !== event.actor
      ) {
        throw new Error("Claimed event details are inconsistent.");
      }
      return details;
    }
    case "transitioned": {
      const details = requireExactObject(value, [
        "fromStatus",
        "toStatus",
        "blockedReason",
        "result",
      ]);
      const fromStatus = requireStatus(details.fromStatus);
      const toStatus = requireStatus(details.toStatus);
      if (
        !(ALLOWED_TRANSITIONS[fromStatus] as readonly TaskStatus[]).includes(
          toStatus,
        )
      ) {
        throw new Error("Transitioned event statuses are inconsistent.");
      }
      const blockedReason = requireNullableText(details.blockedReason);
      const result = requireNullableText(details.result);
      if (
        (toStatus === "blocked") !== (blockedReason !== null) ||
        (toStatus === "done") !== (result !== null)
      ) {
        throw new Error("Transitioned event result fields are inconsistent.");
      }
      return details;
    }
    case "reopened": {
      const details = requireExactObject(value, ["fromStatus", "toStatus"]);
      if (
        !(REOPENABLE_STATUSES as readonly unknown[]).includes(
          details.fromStatus,
        ) ||
        details.toStatus !== "pending"
      ) {
        throw new Error("Reopened event details are inconsistent.");
      }
      return details;
    }
  }
}

function requireVersions(
  type: TaskEventType,
  fromValue: unknown,
  toValue: unknown,
): Readonly<{ fromVersion: number | null; toVersion: number }> {
  if (!Number.isSafeInteger(toValue) || (toValue as number) < 1) {
    throw new Error("Event toVersion is invalid.");
  }
  const toVersion = toValue as number;
  if (type === "created") {
    if (fromValue !== null || toVersion !== 1) {
      throw new Error("Created event versions are inconsistent.");
    }
    return { fromVersion: null, toVersion };
  }
  if (
    !Number.isSafeInteger(fromValue) ||
    (fromValue as number) < 1 ||
    (fromValue as number) + 1 !== toVersion
  ) {
    throw new Error("Event versions are inconsistent.");
  }
  return { fromVersion: fromValue as number, toVersion };
}

function validateActor(type: TaskEventType, actor: string | null): void {
  const requiresActor =
    type === "claimed" || type === "transitioned" || type === "reopened";
  if ((actor !== null) !== requiresActor) {
    throw new Error("Event actor is inconsistent with its type.");
  }
}

function requireExactObject(
  value: unknown,
  fields: readonly string[],
): UnknownRecord {
  const object = requireObject(value);
  const actual = Object.keys(object).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error("Object fields do not match the event schema.");
  }
  return object;
}

function requireObject(value: unknown): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Expected an object.");
  }
  return value as UnknownRecord;
}

function requireIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isWellFormedUnicode(value) ||
    value.trim().length === 0 ||
    [...value].length > TASK_LIMITS.identifierCharacters
  ) {
    throw new Error("Event identifier is invalid.");
  }
  return value;
}

function requireNullableText(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !isWellFormedUnicode(value) ||
    value.trim().length === 0 ||
    [...value].length > TASK_LIMITS.textCharacters
  ) {
    throw new Error("Event text is invalid.");
  }
  return value;
}

function requireTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !RFC_3339_UTC_MILLISECONDS.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new Error("Event timestamp is invalid.");
  }
  return value;
}

function requireEventType(value: unknown): TaskEventType {
  if (!(TASK_EVENT_TYPES as readonly unknown[]).includes(value)) {
    throw new Error("Event type is invalid.");
  }
  return value as TaskEventType;
}

function requireStatus(value: unknown): TaskStatus {
  if (!(TASK_STATUSES as readonly unknown[]).includes(value)) {
    throw new Error("Event status is invalid.");
  }
  return value as TaskStatus;
}
