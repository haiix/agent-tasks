import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { readonly name: string; readonly version: string };
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
  const installedSkill = await runArtifact(
    isolatedCliPath,
    ["skill", "install"],
    directory,
  );
  assert.equal(installedSkill.exitCode, 0);
  assert.equal(installedSkill.response.data.changed, true);
  assert.deepEqual(
    readFileSync(
      join(directory, ".agents", "skills", "agent-tasks", "SKILL.md"),
    ),
    readFileSync(join(repositoryRoot, "skills", "agent-tasks", "SKILL.md")),
  );
});

void test("the npm tarball installs globally with the taskctl command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-tasks-package-"));
  temporaryDirectories.push(directory);
  const packDirectory = join(directory, "pack");
  const installPrefix = join(directory, "global");
  const npmCache = join(directory, "npm-cache");
  mkdirSync(packDirectory);

  const packed = await runNpm(
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory],
    repositoryRoot,
    npmCache,
  );
  assert.equal(packed.exitCode, 0, packed.stderr);
  const packResults = JSON.parse(packed.stdout) as Array<{
    readonly name: string;
    readonly filename: string;
    readonly files: Array<{ readonly path: string }>;
  }>;
  assert.equal(packResults.length, 1);
  const packResult = packResults[0];
  assert.ok(packResult);
  assert.equal(packResult.name, packageMetadata.name);
  assert.deepEqual(packResult.files.map(({ path }) => path).sort(), [
    "LICENSE",
    "README.md",
    "dist/taskctl.mjs",
    "package.json",
  ]);

  const tarballPath = join(packDirectory, packResult.filename);
  const installed = await runNpm(
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--prefix",
      installPrefix,
      tarballPath,
    ],
    directory,
    npmCache,
  );
  assert.equal(installed.exitCode, 0, installed.stderr);

  const commandPath =
    process.platform === "win32"
      ? join(installPrefix, "taskctl.cmd")
      : join(installPrefix, "bin", "taskctl");
  assert.equal(existsSync(commandPath), true);

  const version = await runCommand(commandPath, ["--version"], directory);
  assert.equal(version.exitCode, 0, version.stderr);
  assert.equal(version.stdout, `${packageMetadata.version}\n`);

  const help = await runCommand(commandPath, ["--help"], directory);
  assert.equal(help.exitCode, 0, help.stderr);
  assert.match(help.stdout, /^Usage: taskctl/);

  const initialized = await runCommand(commandPath, ["init"], directory);
  assert.equal(initialized.exitCode, 0, initialized.stderr);
  assert.equal(JSON.parse(initialized.stdout).ok, true);

  const installedSkill = await runCommand(
    commandPath,
    ["skill", "install"],
    directory,
  );
  assert.equal(installedSkill.exitCode, 0, installedSkill.stderr);
  assert.equal(JSON.parse(installedSkill.stdout).data.changed, true);
  assert.equal(
    existsSync(join(directory, ".agents", "skills", "agent-tasks", "SKILL.md")),
    true,
  );
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
  return runCommand(process.execPath, [artifactPath, ...args], cwd).then(
    ({ exitCode, stdout, stderr }) => {
      assert.equal(stderr, "");
      return {
        exitCode,
        response: JSON.parse(stdout) as ArtifactResponse,
      };
    },
  );
}

function runNpm(
  args: readonly string[],
  cwd: string,
  cache: string,
): Promise<ProcessResult> {
  const npmEntryPoint = process.env.npm_execpath;
  assert.notEqual(npmEntryPoint, undefined, "run tests through npm");
  return runCommand(process.execPath, [npmEntryPoint as string, ...args], cwd, {
    ...process.env,
    npm_config_cache: cache,
  });
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && command.endsWith(".cmd"),
      env: environment,
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
        reject(new Error(`Process exited without a code: ${stderr}`));
        return;
      }
      resolve({ exitCode, stdout, stderr });
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
