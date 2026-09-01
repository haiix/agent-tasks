import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(repositoryRoot, "dist");
const packageMetadata = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);
const skillRoot = resolve(repositoryRoot, "skills", "agent-tasks");
const skillFiles = await readSkillFiles(skillRoot);
const skillSource = skillFiles.find(({ path }) => path === "SKILL.md")?.content;
const skillVersion =
  /^metadata:\r?\n(?: {2}.*\r?\n)*? {2}version:\s*["']?([^"'\r\n]+)["']?/mu.exec(
    skillSource ?? "",
  )?.[1];

if (typeof packageMetadata.version !== "string") {
  throw new Error("package.json must contain a string version");
}
if (skillVersion === undefined)
  throw new Error("Skill metadata.version is required");

await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: [resolve(repositoryRoot, "src/cli.ts")],
  outfile: resolve(outputDirectory, "taskctl.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __TASKCTL_VERSION__: JSON.stringify(packageMetadata.version),
    __TASKCTL_SKILL_BUNDLE__: JSON.stringify({
      name: "agent-tasks",
      version: skillVersion,
      files: skillFiles,
    }),
  },
  charset: "utf8",
  legalComments: "none",
  sourcemap: false,
});

async function readSkillFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Skill source cannot contain links: ${absolutePath}`);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        const path = relative(root, absolutePath).split(sep).join("/");
        validateSkillPath(
          path,
          files.map((file) => file.path),
        );
        files.push({ path, content: await readFile(absolutePath, "utf8") });
      } else throw new Error(`Unsupported skill source entry: ${absolutePath}`);
    }
  }
  await visit(root);
  files.sort((left, right) => compareCodePoints(left.path, right.path));
  return files;
}

function validateSkillPath(path, existing) {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    isAbsolute(path) ||
    /^[A-Za-z]:\//u.test(path) ||
    path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    existing.includes(path)
  )
    throw new Error(`Invalid skill path: ${path}`);
}

function compareCodePoints(left, right) {
  const a = [...left].map((character) => character.codePointAt(0));
  const b = [...right].map((character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}
