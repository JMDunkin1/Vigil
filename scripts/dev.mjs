#!/usr/bin/env node

import { spawn } from "node:child_process";

let activeChild = null;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping = true;
    if (activeChild) activeChild.kill(signal);
    else process.exit(0);
  });
}

const buildCode = await run("npm", ["run", "build"]);
if (buildCode !== 0 || stopping) {
  process.exitCode = buildCode || 0;
} else {
  process.exitCode = await run(process.execPath, ["dist/runtime/scripts/dev-server.mjs"]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    activeChild = child;
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (activeChild === child) activeChild = null;
      resolve(signal ? (stopping ? 0 : 1) : (code ?? 1));
    });
  });
}
