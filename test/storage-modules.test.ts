import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";

const storageDirectory = resolve(import.meta.dirname, "../src/storage");

test("storage modules have no circular dependencies", () => {
  const files = readdirSync(storageDirectory)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => resolve(storageDirectory, file));
  const fileSet = new Set(files);
  const imports = new Map(
    files.map((file) => [
      file,
      [...readFileSync(file, "utf8").matchAll(/from "(\.\/[^"]+\.ts)"/g)]
        .flatMap((match) =>
          match[1] === undefined ? [] : [resolve(dirname(file), match[1])],
        )
        .filter((dependency) => fileSet.has(dependency)),
    ]),
  );

  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  function visit(file: string): void {
    if (active.has(file)) {
      const cycleStart = path.indexOf(file);
      const cycle = [...path.slice(cycleStart), file]
        .map((entry) => basename(entry))
        .join(" -> ");
      assert.fail(`Circular storage dependency: ${cycle}`);
    }
    if (visited.has(file)) return;

    active.add(file);
    path.push(file);
    for (const dependency of imports.get(file) ?? []) visit(dependency);
    path.pop();
    active.delete(file);
    visited.add(file);
  }

  for (const file of files) visit(file);
});
