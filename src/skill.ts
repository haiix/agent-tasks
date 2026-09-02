import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareUnicodeCodePoints } from "./validation/primitives.ts";

export interface SkillFile {
  readonly path: string;
  readonly content: string;
}

export interface SkillBundle {
  readonly name: string;
  readonly version: string;
  readonly files: readonly SkillFile[];
}

interface InstallOperations {
  readonly writeFile?: typeof writeFileSync;
}

declare const __TASKCTL_SKILL_BUNDLE__: SkillBundle;

export class SkillConflictError extends Error {
  readonly code = "SKILL_CONFLICT";
  readonly details: Readonly<{ skillPath: string }>;

  constructor(skillPath: string) {
    super("The destination skill already exists with different content.");
    this.name = "SkillConflictError";
    this.details = { skillPath };
  }
}

export function bundledSkill(): SkillBundle {
  const bundle =
    typeof __TASKCTL_SKILL_BUNDLE__ === "undefined"
      ? readDevelopmentBundle()
      : __TASKCTL_SKILL_BUNDLE__;
  validateSkillBundle(bundle);
  return bundle;
}

export function installSkill(
  projectRoot: string,
  bundle: SkillBundle = bundledSkill(),
  operations: InstallOperations = {},
): {
  readonly projectRoot: string;
  readonly skillPath: string;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly changed: boolean;
  readonly files: readonly string[];
} {
  validateSkillBundle(bundle);
  const normalizedRoot = resolve(projectRoot);
  const skillPath = join(normalizedRoot, ".agents", "skills", bundle.name);
  const files = bundle.files.map(({ path }) => path);

  verifyPathElements(normalizedRoot, skillPath);
  if (pathExists(skillPath)) {
    if (!matchesBundle(skillPath, bundle))
      throw new SkillConflictError(skillPath);
    return skillResult(normalizedRoot, skillPath, bundle, false, files);
  }

  const parentPath = dirname(skillPath);
  const createdParents = ensureParents(normalizedRoot, parentPath, skillPath);
  const temporaryPath = join(
    parentPath,
    `.${bundle.name}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    mkdirSync(temporaryPath);
    for (const file of bundle.files) {
      const outputPath = join(temporaryPath, ...file.path.split("/"));
      mkdirSync(dirname(outputPath), { recursive: true });
      (operations.writeFile ?? writeFileSync)(outputPath, file.content, {
        encoding: "utf8",
        flag: "wx",
      });
    }
    if (pathExists(skillPath)) throw new SkillConflictError(skillPath);
    renameSync(temporaryPath, skillPath);
  } catch (error) {
    rmSync(temporaryPath, { recursive: true, force: true });
    removeEmptyParents(createdParents);
    if (error instanceof SkillConflictError) throw error;
    if (pathExists(skillPath)) throw new SkillConflictError(skillPath);
    throw error;
  }
  return skillResult(normalizedRoot, skillPath, bundle, true, files);
}

export function validateSkillBundle(bundle: SkillBundle): void {
  if (bundle.name !== "agent-tasks" || bundle.version.length === 0) {
    throw new Error("Invalid embedded skill metadata.");
  }
  const paths = new Set<string>();
  for (const file of bundle.files) {
    if (
      file.path.length === 0 ||
      file.path.includes("\\") ||
      file.path.startsWith("/") ||
      isAbsolute(file.path) ||
      /^[A-Za-z]:\//u.test(file.path) ||
      file.path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      paths.has(file.path)
    ) {
      throw new Error(`Invalid embedded skill path: ${file.path}`);
    }
    paths.add(file.path);
  }
  const sorted = [...paths].sort(compareUnicodeCodePoints);
  if (
    sorted.length === 0 ||
    sorted.some((path, index) => path !== bundle.files[index]?.path)
  ) {
    throw new Error("Embedded skill paths must be unique and sorted.");
  }
}

function skillResult(
  projectRoot: string,
  skillPath: string,
  bundle: SkillBundle,
  changed: boolean,
  files: readonly string[],
) {
  return {
    projectRoot,
    skillPath,
    skillName: bundle.name,
    skillVersion: bundle.version,
    changed,
    files,
  };
}

function verifyPathElements(projectRoot: string, skillPath: string): void {
  const rootStatus = lstatSync(projectRoot);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new SkillConflictError(skillPath);
  }
  let current = projectRoot;
  for (const part of [".agents", "skills", "agent-tasks"]) {
    current = join(current, part);
    if (!pathExists(current)) continue;
    const status = lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new SkillConflictError(skillPath);
    }
  }
}

function ensureParents(
  projectRoot: string,
  parentPath: string,
  skillPath: string,
): string[] {
  const created: string[] = [];
  try {
    let current = projectRoot;
    for (const part of [".agents", "skills"]) {
      current = join(current, part);
      if (!pathExists(current)) {
        mkdirSync(current);
        created.push(current);
      }
      const status = lstatSync(current);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new SkillConflictError(skillPath);
      }
    }
    if (current !== parentPath)
      throw new Error("Unexpected skill parent path.");
    return created;
  } catch (error) {
    removeEmptyParents(created);
    throw error;
  }
}

function removeEmptyParents(paths: readonly string[]): void {
  for (const path of [...paths].reverse()) {
    try {
      rmdirSync(path);
    } catch {
      // Preserve non-empty directories or directories changed by another process.
    }
  }
}

function matchesBundle(skillPath: string, bundle: SkillBundle): boolean {
  const expectedFiles = new Map(
    bundle.files.map((file) => [file.path, file.content]),
  );
  const actualFiles: string[] = [];
  const visit = (directory: string, relativeDirectory: string): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath =
        relativeDirectory.length === 0
          ? entry.name
          : `${relativeDirectory}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      const status = lstatSync(absolutePath);
      if (status.isSymbolicLink()) return false;
      if (status.isDirectory()) {
        if (!visit(absolutePath, relativePath)) return false;
      } else if (status.isFile()) {
        actualFiles.push(relativePath);
        const expected = expectedFiles.get(relativePath);
        if (
          expected === undefined ||
          !readFileSync(absolutePath).equals(Buffer.from(expected))
        ) {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  };
  return (
    visit(skillPath, "") &&
    actualFiles
      .sort(compareUnicodeCodePoints)
      .every((path, index) => path === bundle.files[index]?.path) &&
    actualFiles.length === bundle.files.length
  );
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR")
      return false;
    throw error;
  }
}

function readDevelopmentBundle(): SkillBundle {
  const root = fileURLToPath(new URL("../skills/agent-tasks", import.meta.url));
  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  const version =
    /^metadata:\r?\n(?: {2}.*\r?\n)*? {2}version:\s*["']?([^"'\r\n]+)["']?/mu.exec(
      skill,
    )?.[1];
  if (version === undefined)
    throw new Error("Skill metadata.version is required.");
  return {
    name: "agent-tasks",
    version,
    files: [
      { path: "SKILL.md", content: skill },
      {
        path: "references/cli-workflow.md",
        content: readFileSync(
          join(root, "references", "cli-workflow.md"),
          "utf8",
        ),
      },
    ],
  };
}

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "";
}
