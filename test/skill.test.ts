import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runCli } from "../src/main.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const skillRoot = join(repositoryRoot, "skills", "agent-tasks");
const skillPath = join(skillRoot, "SKILL.md");
const workflowPath = join(skillRoot, "references", "cli-workflow.md");
const migrationPath = join(repositoryRoot, "documents", "agent-cli-prompt.md");

void test("agent-tasks skill has portable Agent Skills metadata", () => {
  const skill = readFileSync(skillPath, "utf8");
  const frontmatter = readFrontmatter(skill);

  assert.equal(frontmatter.get("name"), "agent-tasks");
  assert.match(frontmatter.get("description") ?? "", /taskctl/);
  assert.match(frontmatter.get("description") ?? "", /select/);
  assert.match(frontmatter.get("description") ?? "", /claim/);
  assert.match(frontmatter.get("description") ?? "", /status update/);
  assert.equal(frontmatter.get("license"), "MIT");
  assert.match(frontmatter.get("compatibility") ?? "", /taskctl.*PATH/);
  assert.equal(frontmatter.get("metadata.author"), "haiix");
  assert.equal(frontmatter.get("metadata.version"), '"1"');
  assert.equal(frontmatter.has("allowed-tools"), false);
  assert.ok(skill.split(/\r?\n/u).length < 500);

  assert.deepEqual(readdirSync(skillRoot).sort(), ["SKILL.md", "references"]);
  assert.deepEqual(readdirSync(join(skillRoot, "references")), [
    "cli-workflow.md",
  ]);
});

void test("all local links in the skill bundle and migration guide resolve", () => {
  for (const path of [skillPath, workflowPath, migrationPath]) {
    const markdown = readFileSync(path, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1];
      assert.ok(target, `empty link target in ${path}`);
      if (/^[a-z]+:/iu.test(target) || target.startsWith("#")) continue;
      assert.equal(
        existsSync(join(dirname(path), target)),
        true,
        `missing link target ${target} in ${path}`,
      );
    }
  }
});

void test("documented taskctl examples match the implemented command parser", () => {
  const reference = readFileSync(workflowPath, "utf8");
  const commands = [...reference.matchAll(/^taskctl (.+)$/gmu)].map(
    (match) => match[1] ?? "",
  );
  assert.ok(commands.length >= 10);
  const emptyProject = mkdtempSync(join(tmpdir(), "agent-tasks-skill-"));

  try {
    for (const command of commands) {
      const args = command.split(" ").map(resolvePlaceholder);
      let stdout = "";
      const result = runCli(args, {
        cwd: emptyProject,
        environment: {},
        readStdin: () => inputFor(args),
        writeStdout(value) {
          stdout += value;
        },
      });
      const response = JSON.parse(stdout) as {
        readonly error?: { readonly code?: string };
      };
      assert.notEqual(
        result.exitCode,
        2,
        `documented command was rejected by the parser: taskctl ${command}`,
      );
      assert.notEqual(response.error?.code, "INVALID_ARGUMENT");
      assert.notEqual(response.error?.code, "VALIDATION_ERROR");
    }
  } finally {
    rmSync(emptyProject, { recursive: true, force: true });
  }
});

function readFrontmatter(markdown: string): Map<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown);
  assert.ok(match?.[1], "SKILL.md must begin with YAML frontmatter");
  const values = new Map<string, string>();
  let parent = "";
  for (const line of match[1].split(/\r?\n/u)) {
    const property = /^(\s*)([a-z-]+):(?:\s+(.*))?$/u.exec(line);
    assert.ok(property, `unsupported frontmatter line: ${line}`);
    const [, indentation = "", key = "", value = ""] = property;
    if (indentation.length === 0) {
      parent = value.length === 0 ? key : "";
      values.set(key, value);
    } else {
      assert.ok(parent, `nested property without parent: ${line}`);
      values.set(`${parent}.${key}`, value);
    }
  }
  return values;
}

function resolvePlaceholder(token: string): string {
  const values: Readonly<Record<string, string>> = {
    "<agent-id>": "agent-a",
    "<cursor>": "cursor-a",
    "<dependency-id>": "01DEPENDENCY",
    "<task-id>": "01TASK",
    "<version>": "1",
  };
  return values[token] ?? token;
}

function inputFor(args: readonly string[]): string {
  if (args[0] === "create") return JSON.stringify({ title: "Example task" });
  if (args[0] === "update") return JSON.stringify({ priority: "high" });
  if (args.includes("blocked"))
    return JSON.stringify({ blockedReason: "Waiting for an API decision." });
  if (args.includes("done"))
    return JSON.stringify({ result: "Implementation and checks completed." });
  return "{}";
}
