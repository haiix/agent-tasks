export interface ValidationIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type DomainErrorCode = "VALIDATION_ERROR" | "STATE_CONFLICT";

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
