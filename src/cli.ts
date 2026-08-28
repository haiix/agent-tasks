import { runCli } from "./main.ts";

const result = runCli(process.argv.slice(2), {
  writeStdout(value) {
    process.stdout.write(value);
  },
});

process.exitCode = result.exitCode;
