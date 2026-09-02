import type { CliResult } from "../main.ts";
import type { getTask, getTaskHistory, listTasks } from "../storage/tasks.ts";
import type { CliIo } from "./handlers.ts";
import type { Command, Format } from "./spec.ts";

export function writeOutput(
  io: CliIo,
  command: Command,
  format: Format,
  data: object,
): CliResult {
  if (format === "json") return writeSuccess(io, data);
  io.writeStdout(formatText(command, data));
  return { exitCode: 0 };
}

function formatText(command: Command, data: object): string {
  if (command === "get") {
    const result = data as ReturnType<typeof getTask>;
    const task = result.task;
    return [
      `ID: ${escapeTextField(task.id)}`,
      `Title: ${escapeTextField(task.title)}`,
      `Status: ${escapeTextField(task.status)}`,
      `Priority: ${escapeTextField(task.priority)}`,
      `Assignee: ${escapeTextField(task.assignee ?? "-")}`,
      `Runnable: ${task.runnable ? "yes" : "no"}`,
      `Depends on: ${
        result.dependsOn.length === 0
          ? "-"
          : result.dependsOn.map(escapeTextField).join(", ")
      }`,
      `Description: ${escapeTextField(task.description || "-")}`,
      "",
    ].join("\n");
  }
  if (command === "list") {
    const result = data as ReturnType<typeof listTasks>;
    const rows = result.tasks.map((task) =>
      [
        escapeTextField(task.id),
        escapeTextField(task.status),
        escapeTextField(task.priority),
        escapeTextField(task.assignee ?? "-"),
        task.runnable ? "yes" : "no",
        escapeTextField(task.title),
      ].join("\t"),
    );
    return [
      "ID\tSTATUS\tPRIORITY\tASSIGNEE\tRUNNABLE\tTITLE",
      ...rows,
      ...(result.nextCursor === null
        ? []
        : [`Next cursor: ${escapeTextField(result.nextCursor)}`]),
      "",
    ].join("\n");
  }
  if (command === "history") {
    const result = data as ReturnType<typeof getTaskHistory>;
    const rows = result.events.map((event) =>
      [
        escapeTextField(event.occurredAt),
        escapeTextField(event.type),
        escapeTextField(event.actor ?? "-"),
        `${event.fromVersion ?? "-"}->${event.toVersion}`,
        escapeTextField(JSON.stringify(event.details)),
      ].join("\t"),
    );
    return [
      "OCCURRED_AT\tTYPE\tACTOR\tVERSION\tDETAILS",
      ...rows,
      ...(result.nextCursor === null
        ? []
        : [`Next cursor: ${escapeTextField(result.nextCursor)}`]),
      "",
    ].join("\n");
  }
  throw new Error(`Text output is not implemented for ${command}.`);
}

function escapeTextField(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f)) {
      escaped += character;
      continue;
    }
    if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (character === "\b") escaped += "\\b";
    else if (character === "\f") escaped += "\\f";
    else {
      const hexadecimal = codePoint.toString(16).toUpperCase().padStart(4, "0");
      escaped += `\\u{${hexadecimal}}`;
    }
  }
  return escaped;
}

function writeSuccess(io: CliIo, data: object): CliResult {
  io.writeStdout(`${JSON.stringify({ ok: true, data })}\n`);
  return { exitCode: 0 };
}

export function writeText(io: CliIo, value: string): CliResult {
  io.writeStdout(value);
  return { exitCode: 0 };
}

export function writeError(
  io: CliIo,
  exitCode: number,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): CliResult {
  io.writeStdout(
    `${JSON.stringify({ ok: false, error: { code, message, details } })}\n`,
  );
  return { exitCode };
}
