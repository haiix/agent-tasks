import { DomainError, type ValidationIssue } from "../errors.ts";
import {
  PRIORITIES,
  TASK_STATUSES,
  type CreateTaskInput,
  type JsonValue,
  type Priority,
  type Task,
  type TaskStatus,
  type TransitionInput,
  type UpdateTaskInput,
} from "../domain/task.ts";

export const TASK_LIMITS = {
  titleCharacters: 200,
  textCharacters: 20_000,
  identifierCharacters: 200,
  labelCharacters: 200,
  labels: 50,
  dependencies: 50,
  metadataBytes: 65_536,
  metadataDepth: 10,
} as const;

const RFC_3339_UTC_MILLISECONDS =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

type UnknownRecord = Record<string, unknown>;

class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  add(path: string, code: string, message: string): void {
    this.issues.push({ path, code, message });
  }

  throwIfAny(): void {
    if (this.issues.length === 0) {
      return;
    }

    this.issues.sort((left, right) =>
      compareUnicodeCodePoints(left.path, right.path),
    );
    throw new DomainError("VALIDATION_ERROR", "Input validation failed.", {
      issues: this.issues,
    });
  }
}

export function validateCreateTaskInput(value: unknown): CreateTaskInput {
  const issues = new IssueCollector();
  const input = requireObject(value, "", issues);
  rejectUnknownFields(
    input,
    ["title", "description", "priority", "labels", "metadata", "dependsOn"],
    issues,
  );

  const title = validateString(input.title, "title", issues, {
    required: true,
    nonBlank: true,
    maxCharacters: TASK_LIMITS.titleCharacters,
  });
  const description = validateString(input.description, "description", issues, {
    defaultValue: "",
    maxCharacters: TASK_LIMITS.textCharacters,
  });
  const priority = validatePriority(
    input.priority,
    "priority",
    issues,
    "normal",
  );
  const labels = validateStringArray(input.labels, "labels", issues, {
    defaultValue: [],
    maxItems: TASK_LIMITS.labels,
    maxCharacters: TASK_LIMITS.labelCharacters,
  });
  const metadata = validateMetadata(input.metadata, "metadata", issues, {});
  const dependsOn = validateStringArray(input.dependsOn, "dependsOn", issues, {
    defaultValue: [],
    maxItems: TASK_LIMITS.dependencies,
    maxCharacters: TASK_LIMITS.identifierCharacters,
  });

  issues.throwIfAny();
  return {
    title: title ?? "",
    description: description ?? "",
    priority: priority ?? "normal",
    labels,
    metadata,
    dependsOn,
  };
}

export function validateTaskDependencies(value: unknown): readonly string[] {
  const issues = new IssueCollector();
  const dependencies = validateStringArray(value, "dependsOn", issues, {
    maxItems: TASK_LIMITS.dependencies,
    maxCharacters: TASK_LIMITS.identifierCharacters,
  });
  issues.throwIfAny();
  return dependencies;
}

export function validateUpdateTaskInput(value: unknown): UpdateTaskInput {
  const issues = new IssueCollector();
  const input = requireObject(value, "", issues);
  const fields = ["title", "description", "priority", "labels", "metadata"];
  rejectUnknownFields(input, fields, issues);

  if (!fields.some((field) => Object.hasOwn(input, field))) {
    issues.add("", "required", "At least one update field is required.");
  }

  const output: {
    title?: string;
    description?: string;
    priority?: Priority;
    labels?: readonly string[];
    metadata?: Readonly<Record<string, JsonValue>>;
  } = {};

  if (Object.hasOwn(input, "title")) {
    const title = validateString(input.title, "title", issues, {
      required: true,
      nonBlank: true,
      maxCharacters: TASK_LIMITS.titleCharacters,
    });
    if (title !== undefined) output.title = title;
  }
  if (Object.hasOwn(input, "description")) {
    const description = validateString(
      input.description,
      "description",
      issues,
      { required: true, maxCharacters: TASK_LIMITS.textCharacters },
    );
    if (description !== undefined) output.description = description;
  }
  if (Object.hasOwn(input, "priority")) {
    const priority = validatePriority(input.priority, "priority", issues);
    if (priority !== undefined) output.priority = priority;
  }
  if (Object.hasOwn(input, "labels")) {
    output.labels = validateStringArray(input.labels, "labels", issues, {
      maxItems: TASK_LIMITS.labels,
      maxCharacters: TASK_LIMITS.labelCharacters,
    });
  }
  if (Object.hasOwn(input, "metadata")) {
    output.metadata = validateMetadata(input.metadata, "metadata", issues);
  }

  issues.throwIfAny();
  return output;
}

export function validateTransitionInput(
  to: TaskStatus,
  value: unknown,
): TransitionInput {
  const issues = new IssueCollector();
  if (to === "blocked" || to === "done") {
    const input = requireObject(value, "", issues);
    const field = to === "blocked" ? "blockedReason" : "result";
    rejectUnknownFields(input, [field], issues);
    const text = validateString(input[field], field, issues, {
      required: true,
      nonBlank: true,
      maxCharacters: TASK_LIMITS.textCharacters,
    });
    issues.throwIfAny();
    return to === "blocked"
      ? { blockedReason: text ?? "" }
      : { result: text ?? "" };
  }

  if (value !== undefined) {
    issues.add("", "unexpected", `Transition to ${to} does not accept input.`);
  }
  issues.throwIfAny();
  return undefined;
}

export function validateTask(value: unknown): Task {
  const issues = new IssueCollector();
  const input = requireObject(value, "", issues);
  const fields = [
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
  ];
  rejectUnknownFields(input, fields, issues);
  requireFields(input, fields, issues);

  const id = validateString(input.id, "id", issues, {
    required: true,
    nonBlank: true,
    maxCharacters: TASK_LIMITS.identifierCharacters,
  });
  const title = validateString(input.title, "title", issues, {
    required: true,
    nonBlank: true,
    maxCharacters: TASK_LIMITS.titleCharacters,
  });
  const description = validateString(input.description, "description", issues, {
    required: true,
    maxCharacters: TASK_LIMITS.textCharacters,
  });
  const status = validateStatus(input.status, "status", issues);
  const priority = validatePriority(input.priority, "priority", issues);
  const assignee = validateNullableString(input.assignee, "assignee", issues, {
    nonBlank: true,
    maxCharacters: TASK_LIMITS.identifierCharacters,
  });
  const blockedReason = validateNullableString(
    input.blockedReason,
    "blockedReason",
    issues,
    { nonBlank: true, maxCharacters: TASK_LIMITS.textCharacters },
  );
  const result = validateNullableString(input.result, "result", issues, {
    nonBlank: true,
    maxCharacters: TASK_LIMITS.textCharacters,
  });
  const labels = validateStringArray(input.labels, "labels", issues, {
    maxItems: TASK_LIMITS.labels,
    maxCharacters: TASK_LIMITS.labelCharacters,
  });
  const metadata = validateMetadata(input.metadata, "metadata", issues);
  const createdAt = validateTimestamp(input.createdAt, "createdAt", issues);
  const updatedAt = validateTimestamp(input.updatedAt, "updatedAt", issues);
  const startedAt = validateNullableTimestamp(
    input.startedAt,
    "startedAt",
    issues,
  );
  const completedAt = validateNullableTimestamp(
    input.completedAt,
    "completedAt",
    issues,
  );
  const version = validateVersion(input.version, "version", issues);

  validateTimestampOrder(createdAt, updatedAt, startedAt, completedAt, issues);
  if (status !== undefined) {
    validateLifecycle(
      status,
      assignee,
      blockedReason,
      result,
      startedAt,
      completedAt,
      issues,
    );
  }

  issues.throwIfAny();
  return {
    id: id ?? "",
    title: title ?? "",
    description: description ?? "",
    status: status ?? "pending",
    priority: priority ?? "normal",
    assignee: assignee ?? null,
    blockedReason: blockedReason ?? null,
    result: result ?? null,
    labels,
    metadata,
    createdAt: createdAt ?? "",
    updatedAt: updatedAt ?? "",
    startedAt: startedAt ?? null,
    completedAt: completedAt ?? null,
    version: version ?? 1,
  };
}

function requireObject(
  value: unknown,
  path: string,
  issues: IssueCollector,
): UnknownRecord {
  if (!isPlainObject(value)) {
    issues.add(path, "type", "Expected an object.");
    return {};
  }
  return value;
}

function rejectUnknownFields(
  input: UnknownRecord,
  allowed: readonly string[],
  issues: IssueCollector,
): void {
  const allowedSet = new Set(allowed);
  for (const field of Object.keys(input)) {
    if (!allowedSet.has(field)) {
      issues.add(field, "unknown_field", "Unknown field.");
    }
  }
}

function requireFields(
  input: UnknownRecord,
  fields: readonly string[],
  issues: IssueCollector,
): void {
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) {
      issues.add(field, "required", "Field is required.");
    }
  }
}

interface StringOptions {
  readonly required?: boolean;
  readonly nonBlank?: boolean;
  readonly maxCharacters: number;
  readonly defaultValue?: string;
}

function validateString(
  value: unknown,
  path: string,
  issues: IssueCollector,
  options: StringOptions,
): string | undefined {
  if (value === undefined) {
    if (options.required === true) {
      issues.add(path, "required", "Field is required.");
    }
    return options.defaultValue;
  }
  if (typeof value !== "string") {
    issues.add(path, "type", "Expected a string.");
    return undefined;
  }
  if (!isWellFormedUnicode(value)) {
    issues.add(path, "unicode", "Value must be well-formed Unicode.");
  }
  if (options.nonBlank === true && value.trim().length === 0) {
    issues.add(path, "blank", "Value must not be blank.");
  }
  if ([...value].length > options.maxCharacters) {
    issues.add(
      path,
      "too_long",
      `Value must contain at most ${options.maxCharacters} characters.`,
    );
  }
  return value;
}

export function isWellFormedUnicode(value: string): boolean {
  return value.isWellFormed();
}

function validateNullableString(
  value: unknown,
  path: string,
  issues: IssueCollector,
  options: Omit<StringOptions, "required" | "defaultValue">,
): string | null | undefined {
  if (value === null) return null;
  return validateString(value, path, issues, { ...options, required: true });
}

function validatePriority(
  value: unknown,
  path: string,
  issues: IssueCollector,
  defaultValue?: Priority,
): Priority | undefined {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (
    typeof value !== "string" ||
    !(PRIORITIES as readonly string[]).includes(value)
  ) {
    issues.add(path, "enum", `Expected one of: ${PRIORITIES.join(", ")}.`);
    return undefined;
  }
  return value as Priority;
}

function validateStatus(
  value: unknown,
  path: string,
  issues: IssueCollector,
): TaskStatus | undefined {
  if (
    typeof value !== "string" ||
    !(TASK_STATUSES as readonly string[]).includes(value)
  ) {
    issues.add(path, "enum", `Expected one of: ${TASK_STATUSES.join(", ")}.`);
    return undefined;
  }
  return value as TaskStatus;
}

interface StringArrayOptions {
  readonly defaultValue?: readonly string[];
  readonly maxItems: number;
  readonly maxCharacters: number;
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: IssueCollector,
  options: StringArrayOptions,
): readonly string[] {
  if (value === undefined && options.defaultValue !== undefined) {
    return options.defaultValue;
  }
  if (!Array.isArray(value)) {
    issues.add(path, "type", "Expected an array.");
    return [];
  }
  if (value.length > options.maxItems) {
    issues.add(path, "too_many", `Expected at most ${options.maxItems} items.`);
  }

  const output: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const text = validateString(item, itemPath, issues, {
      required: true,
      nonBlank: true,
      maxCharacters: options.maxCharacters,
    });
    if (text === undefined) continue;
    if (seen.has(text)) {
      issues.add(itemPath, "duplicate", "Duplicate item.");
    } else {
      seen.add(text);
      output.push(text);
    }
  }
  return output.sort(compareUnicodeCodePoints);
}

function validateMetadata(
  value: unknown,
  path: string,
  issues: IssueCollector,
  defaultValue?: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!isPlainObject(value)) {
    issues.add(path, "type", "Expected an object.");
    return {};
  }

  const seen = new Set<object>();
  validateJsonValue(value, path, 0, seen, issues);
  try {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > TASK_LIMITS.metadataBytes) {
      issues.add(
        path,
        "too_large",
        `Serialized metadata must not exceed ${TASK_LIMITS.metadataBytes} bytes.`,
      );
    }
  } catch {
    issues.add(path, "json", "Metadata must be JSON serializable.");
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function validateJsonValue(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
  issues: IssueCollector,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issues.add(path, "finite", "Number must be finite.");
    }
    return;
  }
  if (typeof value !== "object") {
    issues.add(path, "json", "Expected a JSON-compatible value.");
    return;
  }
  if (depth >= TASK_LIMITS.metadataDepth) {
    issues.add(
      path,
      "too_deep",
      `Metadata must not exceed ${TASK_LIMITS.metadataDepth} levels.`,
    );
    return;
  }
  if (seen.has(value)) {
    issues.add(path, "cycle", "Metadata must not contain cycles.");
    return;
  }

  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateJsonValue(item, `${path}[${index}]`, depth + 1, seen, issues);
    }
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      validateJsonValue(item, joinPath(path, key), depth + 1, seen, issues);
    }
  } else {
    issues.add(path, "json", "Expected a JSON-compatible value.");
  }
  seen.delete(value);
}

function validateTimestamp(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string | undefined {
  if (typeof value !== "string" || !isValidTimestamp(value)) {
    issues.add(
      path,
      "datetime",
      "Expected a UTC RFC 3339 timestamp with exactly three millisecond digits.",
    );
    return undefined;
  }
  return value;
}

function validateNullableTimestamp(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string | null | undefined {
  if (value === null) return null;
  return validateTimestamp(value, path, issues);
}

export function isValidTimestamp(value: string): boolean {
  if (!RFC_3339_UTC_MILLISECONDS.test(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function validateVersion(
  value: unknown,
  path: string,
  issues: IssueCollector,
): number | undefined {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    issues.add(
      path,
      "integer",
      "Expected a safe integer greater than or equal to 1.",
    );
    return undefined;
  }
  return value as number;
}

function validateTimestampOrder(
  createdAt: string | undefined,
  updatedAt: string | undefined,
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  issues: IssueCollector,
): void {
  if (createdAt === undefined || updatedAt === undefined) return;
  if (createdAt > updatedAt) {
    issues.add("updatedAt", "order", "updatedAt must not precede createdAt.");
  }
  for (const [path, value] of [
    ["startedAt", startedAt],
    ["completedAt", completedAt],
  ] as const) {
    if (
      value !== null &&
      value !== undefined &&
      (value < createdAt || value > updatedAt)
    ) {
      issues.add(
        path,
        "order",
        `${path} must be between createdAt and updatedAt.`,
      );
    }
  }
}

function validateLifecycle(
  status: TaskStatus,
  assignee: string | null | undefined,
  blockedReason: string | null | undefined,
  result: string | null | undefined,
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  issues: IssueCollector,
): void {
  const requireNull = (value: unknown, path: string): void => {
    if (value !== null)
      issues.add(path, "state", `Must be null for status ${status}.`);
  };
  const requireValue = (value: unknown, path: string): void => {
    if (value === null || value === undefined) {
      issues.add(path, "state", `Must be set for status ${status}.`);
    }
  };
  const requireClaimPair = (): void => {
    if ((assignee === null) !== (startedAt === null)) {
      issues.add(
        assignee === null ? "assignee" : "startedAt",
        "state",
        "assignee and startedAt must either both be set or both be null.",
      );
    }
  };

  switch (status) {
    case "pending":
      requireNull(assignee, "assignee");
      requireNull(startedAt, "startedAt");
      requireNull(blockedReason, "blockedReason");
      requireNull(result, "result");
      requireNull(completedAt, "completedAt");
      break;
    case "in_progress":
      requireValue(assignee, "assignee");
      requireValue(startedAt, "startedAt");
      requireNull(blockedReason, "blockedReason");
      requireNull(result, "result");
      requireNull(completedAt, "completedAt");
      break;
    case "blocked":
      requireClaimPair();
      requireValue(blockedReason, "blockedReason");
      requireNull(result, "result");
      requireNull(completedAt, "completedAt");
      break;
    case "done":
      requireValue(assignee, "assignee");
      requireValue(startedAt, "startedAt");
      requireNull(blockedReason, "blockedReason");
      requireValue(result, "result");
      requireValue(completedAt, "completedAt");
      break;
    case "canceled":
      requireClaimPair();
      requireNull(blockedReason, "blockedReason");
      requireNull(result, "result");
      requireValue(completedAt, "completedAt");
      break;
  }
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function joinPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map(
    (character) => character.codePointAt(0) ?? 0,
  );
  const rightPoints = [...right].map(
    (character) => character.codePointAt(0) ?? 0,
  );
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
