import { readFileSync } from "node:fs";

import { runCli } from "./main.ts";

declare const __TASKCTL_VERSION__: string;

const version =
  typeof __TASKCTL_VERSION__ === "undefined"
    ? readPackageVersion()
    : __TASKCTL_VERSION__;

const result = runCli(
  process.argv.slice(2),
  {
    writeStdout(value) {
      process.stdout.write(value);
    },
  },
  {
    version,
  },
);

process.exitCode = result.exitCode;

function readPackageVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof metadata.version !== "string")
    throw new Error("package.json must contain a string version");
  return metadata.version;
}
