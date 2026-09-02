import { readFileSync } from "node:fs";

import { isValidIdentifier } from "../validation/primitives.ts";
import { TASK_LIMITS } from "../validation/task.ts";
import {
  COMMANDS,
  COMMAND_SPECS,
  type Command,
  type Format,
  supportsFormat,
} from "./spec.ts";

export interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

export type CliInput =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | {
      readonly kind: "command";
      readonly command: Command;
      readonly options: ParsedOptions;
      readonly format: Format;
    };

export class CliFailure extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CliFailure";
    this.code = code;
    this.details = details;
  }
}

export function parseCliInput(args: readonly string[]): CliInput {
  if (args.length === 1 && args[0] === "--help") return { kind: "help" };
  if (args.length === 1 && args[0] === "--version") return { kind: "version" };
  if (args.length === 0) {
    throw new CliFailure("INVALID_ARGUMENT", "A command is required.", {});
  }

  const command = findCommand(args);
  if (command === undefined) throw unknownCommand(args);
  const spec = COMMAND_SPECS[command];
  const options = parseOptions(command, args.slice(spec.invocation.length));
  const format = parseFormat(options.values.get("--format"));
  if (!supportsFormat(command, format)) {
    throw new CliFailure(
      "UNSUPPORTED_FORMAT",
      `The ${command} command does not support text output.`,
      { format: "text" },
    );
  }
  return { kind: "command", command, options, format };
}

function findCommand(args: readonly string[]): Command | undefined {
  return COMMANDS.find((command) => {
    const invocation = COMMAND_SPECS[command].invocation;
    return invocation.every((part, index) => args[index] === part);
  });
}

function unknownCommand(args: readonly string[]): CliFailure {
  const topLevel = args[0] ?? "";
  const requested =
    topLevel === "skill" && args[1] !== undefined
      ? `skill ${args[1]}`
      : topLevel;
  return new CliFailure("UNKNOWN_COMMAND", `Unknown command: ${requested}`, {
    command: requested,
  });
}

function parseOptions(
  command: Command,
  args: readonly string[],
): ParsedOptions {
  const spec = COMMAND_SPECS[command];
  const valueOptions = spec.valueOptions as readonly string[];
  const flagOptions = spec.flagOptions as readonly string[];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (
      option === undefined ||
      (!valueOptions.includes(option) && !flagOptions.includes(option))
    ) {
      throw invalidArgument(option, undefined, "Unknown option.");
    }
    if (values.has(option) || flags.has(option)) {
      throw invalidArgument(
        option,
        undefined,
        "An option was specified more than once.",
      );
    }
    if (flagOptions.includes(option)) {
      flags.add(option);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0) {
      throw invalidArgument(option, undefined, "An option value is required.");
    }
    values.set(option, value);
    index += 1;
  }
  return { values, flags };
}

export function readJson(
  options: ParsedOptions,
  readStdin?: () => string,
): unknown {
  const value = options.values.get("--input-json");
  if (value === undefined) {
    throw invalidArgument(
      "--input-json",
      undefined,
      "A required option is missing.",
    );
  }
  try {
    const source = value === "-" ? (readStdin ?? readProcessStdin)() : value;
    if (source.length === 0) throw new Error("empty");
    const parsed = JSON.parse(source) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("root");
    }
    return parsed;
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    throw new CliFailure(
      "INVALID_JSON",
      "Input must be a valid JSON object.",
      {},
    );
  }
}

function readProcessStdin(): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(0));
}

export function requiredIdentifier(
  options: ParsedOptions,
  name: string,
): string {
  const value = options.values.get(name);
  if (value === undefined) {
    throw invalidArgument(name, undefined, "A required option is missing.");
  }
  if (!isValidIdentifier(value, TASK_LIMITS.identifierCharacters)) {
    throw invalidArgument(name, value, "Invalid identifier.");
  }
  return value;
}

export function optionalIdentifier(
  options: ParsedOptions,
  name: string,
): string | undefined {
  return options.values.has(name)
    ? requiredIdentifier(options, name)
    : undefined;
}

export function requiredInteger(
  options: ParsedOptions,
  name: string,
  minimum: number,
): number {
  const value = options.values.get(name);
  if (value === undefined) {
    throw invalidArgument(name, undefined, "A required option is missing.");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw invalidArgument(name, value, "Expected a decimal integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw invalidArgument(name, value, "Integer is outside the allowed range.");
  }
  return parsed;
}

export function optionalInteger(
  options: ParsedOptions,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (!options.values.has(name)) return defaultValue;
  const value = requiredInteger(options, name, minimum);
  if (value > maximum) {
    throw invalidArgument(
      name,
      String(value),
      "Integer is outside the allowed range.",
    );
  }
  return value;
}

export function optionalEnum(
  options: ParsedOptions,
  name: string,
  allowed: readonly string[],
): string | undefined {
  const value = options.values.get(name);
  if (value !== undefined && !allowed.includes(value)) {
    throw invalidArgument(name, value, "Invalid option value.");
  }
  return value;
}

export function requiredEnum(
  options: ParsedOptions,
  name: string,
  allowed: readonly string[],
): string {
  const value = options.values.get(name);
  if (value === undefined) {
    throw invalidArgument(name, undefined, "A required option is missing.");
  }
  if (!allowed.includes(value)) {
    throw invalidArgument(name, value, "Invalid option value.");
  }
  return value;
}

function parseFormat(value: string | undefined): Format {
  if (value === undefined || value === "json") return "json";
  if (value === "text") return "text";
  throw invalidArgument("--format", value, "Invalid option value.");
}

function invalidArgument(
  option: string | undefined,
  value: string | undefined,
  message: string,
): CliFailure {
  return new CliFailure("INVALID_ARGUMENT", message, {
    ...(option === undefined ? {} : { option }),
    ...(value === undefined ? {} : { value }),
  });
}
