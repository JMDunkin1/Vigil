import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { UnknownRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export async function currentMacAccountStatus() {
  try {
    const [{ stdout: userOut }, { stdout: groupsOut }] = await Promise.all([
      execFileAsync("/usr/bin/id", ["-un"], { timeout: 1500, maxBuffer: 1024 * 16 }),
      execFileAsync("/usr/bin/id", ["-Gn"], { timeout: 1500, maxBuffer: 1024 * 64 })
    ]);
    return accountStatusFromGroups(userOut.trim(), groupsOut);
  } catch (error) {
    return {
      ok: false,
      username: "",
      groups: [],
      isAdmin: false,
      detail: `Could not inspect macOS account groups: ${simplifyError(error)}`
    };
  }
}

export function accountStatusFromGroups(username: unknown, groupText: unknown) {
  const groups = parseGroups(groupText);
  const isAdmin = groups.includes("admin");
  return {
    ok: !isAdmin,
    username: String(username || "").trim(),
    groups,
    isAdmin,
    detail: isAdmin
      ? "Current user is an admin. For strongest Foolproof mode, use a standard daily account and keep admin credentials away from the desk."
      : "Current user is a standard account."
  };
}

export function parseGroups(value: unknown): string[] {
  return [...new Set(String(value || "")
    .split(/\s+/)
    .map((group) => group.trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function simplifyError(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as UnknownRecord : {};
  return String(record.stderr || record.message || error || "").trim().split("\n").at(-1) || "";
}
