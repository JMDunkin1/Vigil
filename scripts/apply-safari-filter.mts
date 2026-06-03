import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadStateForScript } from "../src/hardening.js";
import { SAFARI_FILTER_PROFILE_PATH, safariFilterStatus, writeSafariFilterProfile } from "../src/safariFilter.js";

const execFileAsync = promisify(execFile);

const state = await loadStateForScript();
const written = await writeSafariFilterProfile(state);
await execFileAsync("/usr/bin/plutil", ["-lint", written.path], {
  timeout: 5000,
  maxBuffer: 1024 * 64
});
await execFileAsync("/usr/bin/open", [written.path], {
  timeout: 5000,
  maxBuffer: 1024 * 64
});

const status = await safariFilterStatus(state);
console.log([
  `Safari URL filter profile opened: ${SAFARI_FILTER_PROFILE_PATH}`,
  `Deny URLs: ${written.urlCount}; path-specific URLs: ${written.pathUrlCount}.`,
  status.installed
    ? `Installed profile detected${status.stale ? " but it is stale; approve the newly opened profile." : "."}`
    : "Approve the profile in System Settings to activate Safari path blocking."
].join("\n"));
