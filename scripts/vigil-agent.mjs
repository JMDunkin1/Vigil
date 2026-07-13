#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const baseUrl = String(process.env.VIGIL_URL || `http://127.0.0.1:${process.env.VIGIL_PORT || 8787}`).replace(/\/$/, "");

const resources = Object.freeze({
  settings: "/api/settings",
  profile: "/api/profile",
  schedule: "/api/schedule",
  limit: "/api/limit",
  appLock: "/api/app-lock",
  intentionalGoal: "/api/intentional-use/goal",
  intentionalRule: "/api/intentional-use/rule",
  accountability: "/api/intentional-use/accountability",
  grayscaleSettings: "/api/grayscale/settings",
  grayscaleSchedule: "/api/grayscale/schedule",
  iosSettings: "/api/devices/ios/settings",
  iosMdmSettings: "/api/devices/ios/mdm/settings",
  journalSecurity: "/api/intentional-use/journal/security"
});

const contract = Object.freeze({
  name: "Vigil agent configuration interface",
  version: 1,
  baseUrl,
  safety: [
    "All changes use Vigil's local HTTP API.",
    "Protected settings still require an active maintenance window.",
    "Apply is additive or updating only; deletion is intentionally not exposed."
  ],
  commands: {
    describe: "npm run agent -- describe",
    snapshot: "npm run agent -- snapshot",
    set: "npm run agent -- set <setting-key> <json-value>",
    applyFile: "npm run agent -- apply ./operations.json",
    applyStdin: "cat operations.json | npm run agent -- apply -"
  },
  applyShape: {
    operations: [
      { resource: "settings", values: { intentionalUseEnabled: true } },
      { resource: "limit", values: { id: "optional-existing-id", name: "Social", type: "time", limitMinutes: 20, days: [0, 1, 2, 3, 4, 5, 6], apps: ["Instagram"], sites: ["instagram.com"], enabled: true } }
    ]
  },
  resources
});

const [command = "help", ...args] = process.argv.slice(2);

try {
  if (command === "describe") {
    write(contract);
  } else if (command === "snapshot") {
    write(configurationSnapshot(await request("/api/state")));
  } else if (command === "set") {
    const [key, rawValue] = args;
    if (!key || rawValue === undefined) fail("Usage: npm run agent -- set <setting-key> <json-value>");
    const value = parseJsonValue(rawValue);
    const result = await mutate("settings", { [key]: value });
    if (!Array.isArray(result.keys) || !result.keys.includes(key)) fail(`Unknown setting key: ${key}`);
    write({ ok: true, applied: [{ resource: "settings", keys: result.keys || [key] }], snapshot: configurationSnapshot(await request("/api/state")) });
  } else if (command === "apply") {
    const source = args[0] || "-";
    const payload = JSON.parse(source === "-" ? await readStdin() : await readFile(source, "utf8"));
    const operations = Array.isArray(payload) ? payload : payload?.operations;
    if (!Array.isArray(operations) || !operations.length) fail("Apply input must contain a non-empty operations array.");
    const validatedOperations = operations.map(validateOperation);
    const applied = [];
    for (const [index, operation] of validatedOperations.entries()) {
      try {
        const result = await mutate(operation.resource, operation.values);
        if (operation.resource === "settings" && (!Array.isArray(result.keys) || !result.keys.length)) {
          fail("The settings operation did not contain any recognized setting keys.");
        }
        applied.push({ resource: operation.resource, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!applied.length) throw error;
        fail(`Operation ${index + 1} (${operation.resource}) failed after ${applied.length} operation${applied.length === 1 ? "" : "s"} applied. Do not rerun the batch blindly. ${message}`);
      }
    }
    write({ ok: true, applied, snapshot: configurationSnapshot(await request("/api/state")) });
  } else {
    process.stdout.write([
      "Vigil agent configuration interface",
      "",
      "  npm run agent -- describe",
      "  npm run agent -- snapshot",
      "  npm run agent -- set <setting-key> <json-value>",
      "  npm run agent -- apply <file|->",
      "",
      "Use describe for the machine-readable contract."
    ].join("\n") + "\n");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function mutate(resource, values) {
  return await request(resources[resource], {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: JSON.stringify(values)
  });
}

function validateOperation(operation, index) {
  const resource = String(operation?.resource || "");
  if (!Object.hasOwn(resources, resource)) fail(`Operation ${index + 1} has unknown resource: ${resource || "(missing)"}`);
  if (!operation.values || typeof operation.values !== "object" || Array.isArray(operation.values)) {
    fail(`Operation ${index + 1} (${resource}) must include a values object.`);
  }
  return { resource, values: operation.values };
}

async function request(path, init = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch {
    throw new Error(`Vigil is not reachable at ${baseUrl}. Open the app or start the local server first.`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${body.error || `request failed (${response.status})`}`);
  return body;
}

function configurationSnapshot(data) {
  return {
    generatedAt: new Date().toISOString(),
    app: data.app || {},
    configuration: {
      settings: data.state?.settings || {},
      profiles: data.state?.profiles || [],
      schedules: data.state?.schedules || [],
      grayscale: data.state?.grayscale || {},
      limits: data.limits?.rules || [],
      appLocks: data.appLocks?.rules || [],
      intentionalUse: {
        goal: data.intentionalUse?.goal || {},
        rules: data.intentionalUse?.rules || [],
        accountability: data.intentionalUse?.accountability || {}
      },
      devices: data.devices || {}
    }
  };
}

function parseJsonValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  throw new Error(message);
}
