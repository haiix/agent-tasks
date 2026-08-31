import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const builtCliPath = fileURLToPath(
  new URL("../dist/taskctl.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("the single ESM artifact runs without repository files", async () => {
  assert.equal(existsSync(builtCliPath), true, "run the build before tests");
  const directory = mkdtempSync(join(tmpdir(), "agent-tasks-dist-"));
  temporaryDirectories.push(directory);
  const isolatedCliPath = join(directory, "taskctl.mjs");
  copyFileSync(builtCliPath, isolatedCliPath);
  assert.deepEqual(readdirSync(directory), ["taskctl.mjs"]);

  const initialized = await runArtifact(isolatedCliPath, ["init"], directory);
  assert.equal(initialized.exitCode, 0);
  assert.equal(initialized.response.ok, true);
  const created = await runArtifact(
    isolatedCliPath,
    ["create", "--input-json", JSON.stringify({ title: "Smoke test" })],
    directory,
  );
  assert.equal(created.exitCode, 0);
  assert.equal(readTaskTitle(created.response), "Smoke test");
});

interface ArtifactResponse {
  readonly ok: boolean;
  readonly data: Record<string, unknown>;
}

function runArtifact(
  artifactPath: string,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly exitCode: number; readonly response: ArtifactResponse }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [artifactPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === null) {
        reject(new Error(`Artifact exited without a code: ${stderr}`));
        return;
      }
      assert.equal(stderr, "");
      const response = JSON.parse(stdout) as ArtifactResponse;
      resolve({ exitCode, response });
    });
  });
}

function readTaskTitle(response: ArtifactResponse): string {
  const task = response.data.task;
  assert.equal(typeof task, "object");
  assert.notEqual(task, null);
  assert.equal(Array.isArray(task), false);
  const title = (task as Record<string, unknown>).title;
  assert.equal(typeof title, "string");
  return title as string;
}
