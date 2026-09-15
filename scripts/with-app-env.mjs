#!/usr/bin/env node
/**
 * Thin wrapper used by npm scripts. On Grok sandbox this injected app env;
 * on Render/local it just runs the remaining argv with the current process env.
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/with-app-env.mjs <command> [args...]");
  process.exit(1);
}

const [cmd, ...cmdArgs] = args;
const child = spawn(cmd, cmdArgs, {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
