import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { runCli } from "../src/main.ts";
import {
  bundledSkill,
  installSkill,
  validateSkillBundle,
} from "../src/skill.ts";

const temporaryDirectories: string[] = [];
const sourceRoot = resolve(import.meta.dirname, "..", "skills", "agent-tasks");
const expectedFiles = ["SKILL.md", "references/cli-workflow.md"];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("installs the embedded skill explicitly and is idempotent", () => {
  const project = temporaryDirectory();
  const first = capture(["skill", "install", "--project", project], project);
  const second = capture(["skill", "install", "--project", project], project);
  const skillPath = join(project, ".agents", "skills", "agent-tasks");

  assert.equal(first.result.exitCode, 0);
  assert.deepEqual(first.response, {
    ok: true,
    data: {
      projectRoot: project,
      skillPath,
      skillName: "agent-tasks",
      skillVersion: "1",
      changed: true,
      files: expectedFiles,
    },
  });
  assert.equal(second.result.exitCode, 0);
  assert.equal(second.response.data?.changed, false);
  for (const file of expectedFiles) {
    assert.deepEqual(
      readFileSync(join(skillPath, ...file.split("/"))),
      readFileSync(join(sourceRoot, ...file.split("/"))),
    );
  }
});

void test("discovers a project from a deep directory and ignores AGENT_TASKS_DB", () => {
  const project = temporaryDirectory();
  const deep = join(project, "packages", "app", "src");
  mkdirSync(deep, { recursive: true });
  capture(["init"], project);

  const installed = capture(["skill", "install"], deep, {
    AGENT_TASKS_DB: join(temporaryDirectory(), "other.sqlite"),
  });

  assert.equal(installed.result.exitCode, 0);
  assert.equal(installed.response.data?.projectRoot, project);
  assert.equal(
    existsSync(join(project, ".agents", "skills", "agent-tasks")),
    true,
  );
});

void test("does not create files when no initialized project is found", () => {
  const directory = temporaryDirectory();
  const captured = capture(["skill", "install"], directory);

  assert.equal(captured.result.exitCode, 3);
  assert.equal(captured.response.error?.code, "NOT_INITIALIZED");
  assert.equal(existsSync(join(directory, ".agents")), false);
});

void test("rejects missing and non-directory explicit projects", () => {
  const directory = temporaryDirectory();
  const missing = join(directory, "missing");
  const file = join(directory, "project.txt");
  writeFileSync(file, "file");

  for (const project of [missing, file]) {
    const captured = capture(
      ["skill", "install", "--project", project],
      directory,
    );
    assert.equal(captured.result.exitCode, 2);
    assert.equal(captured.response.error?.code, "INVALID_ARGUMENT");
    assert.deepEqual(captured.response.error?.details, {
      option: "--project",
      value: project,
    });
  }
  assert.equal(existsSync(join(directory, ".agents")), false);
});

void test("reports every destination content difference as SKILL_CONFLICT", () => {
  for (const mutation of ["changed", "missing", "added"] as const) {
    const project = temporaryDirectory();
    capture(["skill", "install", "--project", project], project);
    const skillPath = join(project, ".agents", "skills", "agent-tasks");
    if (mutation === "changed")
      writeFileSync(join(skillPath, "SKILL.md"), "changed");
    if (mutation === "missing") rmSync(join(skillPath, "SKILL.md"));
    if (mutation === "added")
      writeFileSync(join(skillPath, "extra.md"), "extra");

    const before = snapshot(skillPath);
    const captured = capture(
      ["skill", "install", "--project", project],
      project,
    );
    assert.equal(captured.result.exitCode, 4);
    assert.deepEqual(captured.response, {
      ok: false,
      error: {
        code: "SKILL_CONFLICT",
        message: "The destination skill already exists with different content.",
        details: { skillPath },
      },
    });
    assert.deepEqual(snapshot(skillPath), before);
  }
});

void test("rejects regular-file and link path collisions without writing through them", (context) => {
  const fileProject = temporaryDirectory();
  writeFileSync(join(fileProject, ".agents"), "collision");
  const fileResult = capture(
    ["skill", "install", "--project", fileProject],
    fileProject,
  );
  assert.equal(fileResult.result.exitCode, 4);
  assert.equal(readFileSync(join(fileProject, ".agents"), "utf8"), "collision");

  const linkProject = temporaryDirectory();
  const outside = temporaryDirectory();
  try {
    symlinkSync(outside, join(linkProject, ".agents"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      context.diagnostic("junction creation is unavailable on this runner");
      return;
    }
    throw error;
  }
  const linkResult = capture(
    ["skill", "install", "--project", linkProject],
    linkProject,
  );
  assert.equal(linkResult.result.exitCode, 4);
  assert.equal(readdirSync(outside).length, 0);
});

void test("rejects unsupported skill install options and text output", () => {
  const project = temporaryDirectory();
  for (const args of [
    ["skill", "install", "--force"],
    ["skill", "install", "--db", "tasks.sqlite"],
  ]) {
    const captured = capture(args, project);
    assert.equal(captured.result.exitCode, 2);
    assert.equal(captured.response.error?.code, "INVALID_ARGUMENT");
  }
  const text = capture(
    ["skill", "install", "--project", project, "--format", "text"],
    project,
  );
  assert.equal(text.result.exitCode, 2);
  assert.equal(text.response.error?.code, "UNSUPPORTED_FORMAT");

  const flattened = capture(["skill-install", "--project", project], project);
  assert.equal(flattened.result.exitCode, 2);
  assert.equal(flattened.response.error?.code, "UNKNOWN_COMMAND");
});

void test("removes partial and temporary output when writing fails", () => {
  const project = temporaryDirectory();
  let writes = 0;

  assert.throws(
    () =>
      installSkill(project, bundledSkill(), {
        writeFile(path, data, options) {
          writes += 1;
          if (writes === 2) throw new Error("simulated write failure");
          return writeFileSync(path, data, options);
        },
      }),
    /simulated write failure/,
  );

  assert.equal(existsSync(join(project, ".agents")), false);
  assert.deepEqual(readdirSync(project), []);
});

void test("rejects unsafe embedded paths at runtime", () => {
  for (const path of [
    "../outside",
    "/absolute",
    "C:/absolute",
    "mixed\\path",
  ]) {
    assert.throws(
      () =>
        validateSkillBundle({
          name: "agent-tasks",
          version: "1",
          files: [{ path, content: "unsafe" }],
        }),
      /Invalid embedded skill path/,
    );
  }
  assert.throws(
    () =>
      validateSkillBundle({
        name: "agent-tasks",
        version: "1",
        files: [
          { path: "SKILL.md", content: "one" },
          { path: "SKILL.md", content: "two" },
        ],
      }),
    /Invalid embedded skill path/,
  );
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-tasks-skill-install-"));
  temporaryDirectories.push(directory);
  return directory;
}

function capture(
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  let stdout = "";
  const result = runCli(args, {
    cwd,
    environment,
    writeStdout(value) {
      stdout += value;
    },
  });
  return { result, response: JSON.parse(stdout) as Response };
}

function snapshot(root: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[path.slice(root.length + 1)] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return files;
}

interface Response {
  readonly ok: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>>;
  };
}
