#!/usr/bin/env node
// Spawn `tsx watch` with stdin ignored.
//
// tsx watch listens on stdin for its press-Return-to-restart shortcut. Under turbo on Windows that
// inherited handle never delivers and never closes, and the watched service then never reaches its
// entrypoint: no output, no port, no error. These services are non-interactive, so nothing is lost.
// The redirect lives here rather than in the dev scripts because `< NUL` and `< /dev/null` differ.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const child = spawn(process.execPath, [tsxCli, "watch", ...process.argv.slice(2)], {
  stdio: ["ignore", "inherit", "inherit"],
});

const onSigint = () => child.kill("SIGINT");
const onSigterm = () => child.kill("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

child.on("exit", (code, signal) => {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
