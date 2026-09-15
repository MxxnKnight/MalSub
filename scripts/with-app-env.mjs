#!/usr/bin/env node
/**
 * Thin wrapper used by npm scripts. Resolves local node_modules/.bin so
 * `vite` works on hosts (Render) where it is not on PATH.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/with-app-env.mjs <command> [args...]");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "node_modules", ".bin");

// Prefer local bin (Render/npm ci installs here; bare `vite` is often not on PATH)
const pathSep = process.platform === "win32" ? ";" : ":";
const env = {
  ...process.env,
  PATH: `${binDir}${pathSep}${process.env.PATH ?? ""}`,
};

let [cmd, ...cmdArgs] = args;

// If the command is a local binary name, point at the file explicitly
const localBin = join(binDir, cmd);
const localBinCmd = process.platform === "win32" ? `${localBin}.cmd` : localBin;
if (existsSync(localBinCmd)) {
  cmd = localBinCmd;
} else if (existsSync(localBin)) {
  cmd = localBin;
}

const child = spawn(cmd, cmdArgs, {
  stdio: "inherit",
  env,
  cwd: root,
  shell: process.platform === "win32",
});

child.on("error", (err) => {
  console.error(`[with-app-env] failed to run ${args[0]}:`, err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
