import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(repositoryRoot, "dist");
const packageMetadata = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);

if (typeof packageMetadata.version !== "string") {
  throw new Error("package.json must contain a string version");
}

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
  },
  charset: "utf8",
  legalComments: "none",
  sourcemap: false,
});
