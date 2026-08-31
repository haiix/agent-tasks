export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type DomainErrorCode = "VALIDATION_ERROR" | "STATE_CONFLICT";

export type StorageErrorCode =
  "DB_BUSY" | "DB_INVALID" | "SCHEMA_VERSION_UNSUPPORTED" | "STORAGE_ERROR";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details: Readonly<{ dbPath: string }>;

  constructor(
    code: StorageErrorCode,
    message: string,
    dbPath: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StorageError";
    this.code = code;
    this.details = { dbPath };
  }
}
