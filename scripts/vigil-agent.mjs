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
  version: 2,
  baseUrl,
  safety: [
    "All changes use Vigil's local HTTP API.",
    "Protected settings still require an active maintenance window.",
    "Apply is additive or updating only; deletion is intentionally not exposed.",
    "Updates use Vigil's existing authenticated guardian transaction; this interface cannot suspend protection directly.",
    "The update command waits through the protected restart and verifies the selected build is installed.",
    "Relaunch verifies restart supervision first and waits for a new live runtime generation."
  ],
  commands: {
    describe: "npm run agent -- describe",
    snapshot: "npm run agent -- snapshot",
    set: "npm run agent -- set <setting-key> <json-value>",
    applyFile: "npm run agent -- apply ./operations.json",
    applyStdin: "cat operations.json | npm run agent -- apply -",
    updateStatus: "npm run agent -- update-status",
    updateCheck: "npm run agent -- update-check",
    update: "npm run agent:update -- [--allow-local] [--timeout-seconds 1200]",
    relaunch: "npm run agent:relaunch -- [--timeout-seconds 90]"
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
  } else if (command === "update-status") {
    write(await updateStatus(false));
  } else if (command === "update-check") {
    write(await updateStatus(true));
  } else if (command === "update") {
    write(await runProtectedUpdate(parseUpdateOptions(args)));
  } else if (command === "relaunch") {
    write(await runProtectedRelaunch(parseRelaunchOptions(args)));
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
      "  npm run agent -- update-status",
      "  npm run agent -- update-check",
      "  npm run agent:update -- [--allow-local] [--timeout-seconds 1200]",
      "  npm run agent:relaunch -- [--timeout-seconds 90]",
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

async function runProtectedUpdate(options) {
  const selected = await updateStatus(true);
  assertUsableUpdateStatus(selected);
  if (selected.running === true || selected.recoveryPending === true) {
    return await waitForProtectedUpdate(selected, options);
  }
  if (selected.recoveryBlocked === true) {
    throw new Error(selected.message || "Vigil cannot update until its protected recovery blocker is resolved.");
  }
  if (selected.localChanges === true && !options.allowLocal) {
    throw new Error(
      "Vigil selected a local checkout build instead of a standard remote update. Rerun with --allow-local only to install that exact checkout."
    );
  }
  if (selected.updateAvailable !== true) {
    return {
      ok: true,
      updated: false,
      noUpdate: true,
      phase: selected.phase || "",
      message: selected.message || "Vigil is already current.",
      status: selected
    };
  }

  const target = selectedUpdateTarget(selected);
  let started = await startProtectedUpdate();
  if (started.setupComplete === true) {
    const refreshed = await updateStatus(true);
    assertUsableUpdateStatus(refreshed);
    if (refreshed.localChanges === true && !options.allowLocal) {
      throw new Error(
        "Protected updater setup completed, but Vigil now selected a local checkout build. Rerun with --allow-local only if that checkout should be installed."
      );
    }
    if (refreshed.updateAvailable !== true) {
      return {
        ok: true,
        updated: false,
        noUpdate: true,
        setupComplete: true,
        message: refreshed.message || "Protected updater setup completed; Vigil is already current.",
        status: refreshed
      };
    }
    started = await startProtectedUpdate();
  }
  if (started.ok !== true) {
    throw new Error(started.error || started.message || "Vigil's protected update could not start.");
  }
  return await waitForProtectedUpdate({ ...selected, ...started }, options, target);
}

async function updateStatus(checkRemote) {
  return await request(checkRemote ? "/api/app-update/status?check=1" : "/api/app-update/status");
}

async function startProtectedUpdate() {
  return await request("/api/app-update/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: "{}"
  });
}

async function runProtectedRelaunch(options) {
  const before = await request("/api/health");
  const previousStartedAt = String(before?.app?.startedAt || "");
  if (!previousStartedAt || before?.liveness?.ok !== true) {
    throw new Error("Vigil could not verify the current runtime generation before relaunch.");
  }
  const accepted = await request("/api/app-relaunch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app"
    },
    body: "{}"
  });
  if (accepted?.ok !== true || accepted?.relaunching !== true) {
    throw new Error(accepted?.error || accepted?.message || "Vigil did not accept the protected relaunch.");
  }

  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let observedUnavailable = false;
  let lastIssue = "";
  while (Date.now() < deadline) {
    await delay(options.pollMilliseconds);
    try {
      const health = await request("/api/health");
      const startedAt = String(health?.app?.startedAt || "");
      if (health?.liveness?.ok === true && startedAt && startedAt !== previousStartedAt) {
        return {
          ok: true,
          relaunched: true,
          previousStartedAt,
          startedAt,
          observedUnavailable,
          message: "Vigil relaunched under its restart supervisor and returned alive.",
          health
        };
      }
      lastIssue = startedAt === previousStartedAt
        ? "The original Vigil runtime is still responding."
        : "The replacement Vigil runtime has not reported liveness yet.";
    } catch (error) {
      observedUnavailable = true;
      lastIssue = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    `Vigil did not return as a new runtime generation within ${options.timeoutSeconds} seconds. ${lastIssue}`
  );
}

async function waitForProtectedUpdate(initial, options, selectedTarget = selectedUpdateTarget(initial)) {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let lastStatus = initial;
  let observedTransaction = initial.running === true || activeUpdatePhase(initial.phase);
  let unavailableSince = 0;
  let lastHealthIssue = "";

  while (Date.now() < deadline) {
    await delay(options.pollMilliseconds);
    try {
      lastStatus = await updateStatus(false);
      unavailableSince = 0;
    } catch (error) {
      if (!unavailableSince) unavailableSince = Date.now();
      if (Date.now() - unavailableSince > options.maxUnavailableSeconds * 1000) {
        throw new Error(
          `Vigil did not return after its protected restart: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      continue;
    }

    if (lastStatus.running === true || lastStatus.recoveryPending === true || activeUpdatePhase(lastStatus.phase)) {
      observedTransaction = true;
      continue;
    }
    if (lastStatus.recoveryBlocked === true || lastStatus.phase === "failed") {
      throw new Error(lastStatus.message || lastStatus.error || "Vigil's protected update failed.");
    }
    if (selectedTarget && installedTargetMatches(lastStatus, selectedTarget)) {
      const health = await healthyRuntime();
      if (!health.ok) {
        lastHealthIssue = health.message;
        continue;
      }
      return {
        ok: true,
        updated: true,
        phase: "complete",
        message: lastStatus.message || "Vigil updated and returned healthy.",
        target: selectedTarget,
        health: health.status,
        status: lastStatus
      };
    }
    if (observedTransaction && lastStatus.phase === "complete") {
      const health = await healthyRuntime();
      if (!health.ok) {
        lastHealthIssue = health.message;
        continue;
      }
      return {
        ok: true,
        updated: true,
        phase: "complete",
        message: lastStatus.message || "Vigil updated and returned healthy.",
        target: selectedTarget,
        health: health.status,
        status: lastStatus
      };
    }
  }

  throw new Error(
    `Vigil's protected update did not reach a verified terminal state within ${options.timeoutSeconds} seconds. `
    + String(lastHealthIssue || lastStatus.message || "")
  );
}

async function healthyRuntime() {
  try {
    const status = await request("/api/health");
    const livenessOk = status?.liveness?.ok === true;
    const readinessOk = status?.readiness?.ok === true;
    if (livenessOk && readinessOk) return { ok: true, status };
    const blockers = Array.isArray(status?.readiness?.blockers)
      ? status.readiness.blockers.map(String).filter(Boolean).join(", ")
      : "";
    return {
      ok: false,
      status,
      message: blockers
        ? `The updated Vigil runtime is not ready: ${blockers}`
        : "The updated Vigil runtime has not reported healthy readiness."
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      message: `The updated Vigil runtime health check failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function selectedUpdateTarget(status) {
  if (status.localChanges === true) {
    const commit = cleanIdentifier(status.currentCommit, /^[a-f0-9]{40}$/iu);
    const fingerprint = cleanIdentifier(status.currentSourceFingerprint, /^[a-f0-9]{64}$/iu);
    return commit && fingerprint ? { kind: "local", commit, fingerprint } : null;
  }
  const commit = cleanIdentifier(status.upstreamCommit, /^[a-f0-9]{40}$/iu);
  return commit ? { kind: "remote", commit } : null;
}

function installedTargetMatches(status, target) {
  if (String(status.appCommit || "") !== target.commit) return false;
  return target.kind !== "local" || String(status.appSourceFingerprint || "") === target.fingerprint;
}

function activeUpdatePhase(value) {
  return ["starting", "building", "staging", "installing", "verifying", "restarting", "recovering", "waiting"].includes(String(value || ""));
}

function assertUsableUpdateStatus(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("Vigil returned an invalid updater status.");
  }
  if (status.ok !== true || status.checkOk === false) {
    throw new Error(status.error || status.message || status.remoteCheckError || "Vigil could not verify its update source.");
  }
  if (status.supported !== true) {
    throw new Error(status.message || "This Vigil runtime does not support protected app updates.");
  }
}

function parseUpdateOptions(args) {
  let allowLocal = false;
  let timeoutSeconds = 20 * 60;
  let pollMilliseconds = 1_000;
  let maxUnavailableSeconds = 90;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--allow-local") {
      allowLocal = true;
      continue;
    }
    if (["--timeout-seconds", "--poll-milliseconds", "--max-unavailable-seconds"].includes(argument)) {
      const rawValue = args[++index];
      if (rawValue === undefined) fail(`Missing value for ${argument}.`);
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value <= 0) fail(`${argument} must be a positive number.`);
      if (argument === "--timeout-seconds") timeoutSeconds = value;
      if (argument === "--poll-milliseconds") pollMilliseconds = value;
      if (argument === "--max-unavailable-seconds") maxUnavailableSeconds = value;
      continue;
    }
    fail(`Unknown update option: ${argument}`);
  }
  return { allowLocal, timeoutSeconds, pollMilliseconds, maxUnavailableSeconds };
}

function parseRelaunchOptions(args) {
  let timeoutSeconds = 90;
  let pollMilliseconds = 250;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--timeout-seconds", "--poll-milliseconds"].includes(argument)) {
      const rawValue = args[++index];
      if (rawValue === undefined) fail(`Missing value for ${argument}.`);
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value <= 0) fail(`${argument} must be a positive number.`);
      if (argument === "--timeout-seconds") timeoutSeconds = value;
      if (argument === "--poll-milliseconds") pollMilliseconds = value;
      continue;
    }
    fail(`Unknown relaunch option: ${argument}`);
  }
  return { timeoutSeconds, pollMilliseconds };
}

function cleanIdentifier(value, pattern) {
  const text = String(value || "");
  return pattern.test(text) ? text : "";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
