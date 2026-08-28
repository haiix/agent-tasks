import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../src/main.ts";

void test("returns a machine-readable error when no command is provided", () => {
  let stdout = "";

  const result = runCli([], {
    writeStdout(value) {
      stdout += value;
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stdout.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(stdout), {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message: "A command is required.",
      details: {},
    },
  });
});

void test("reports an unknown command without throwing", () => {
  let stdout = "";

  const result = runCli(["unknown"], {
    writeStdout(value) {
      stdout += value;
    },
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(stdout), {
    ok: false,
    error: {
      code: "INVALID_ARGUMENT",
      message: "Unknown command: unknown",
      details: { command: "unknown" },
    },
  });
});
