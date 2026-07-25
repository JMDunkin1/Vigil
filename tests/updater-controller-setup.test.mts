import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "electron";
import {
  createVigilAppUpdateController,
  guardianCheckFailure
} from "../app/updater.js";
import type { GuardianMaintenanceReadiness } from "../src/updateMaintenance.js";

function fakeApp(userData: string): App {
  return {
    isPackaged: false,
    getPath(name: string) {
      if (name === "userData") return userData;
      if (name === "home") return homedir();
      throw new Error(`Unexpected fake app path request: ${name}`);
    }
  } as unknown as App;
}

function setupRequiredReadiness(ready: boolean): GuardianMaintenanceReadiness {
  return ready
    ? {
        ready: true,
        guardianInstalled: true,
        reason: "ready",
        setupRequired: false,
        setupSupported: true,
        message: null
      }
    : {
        ready: false,
        guardianInstalled: true,
        reason: "outdated-revision",
        setupRequired: true,
        setupSupported: true,
        message: "Guardian protocol setup is required."
      };
}

const setupRoot = await realpath(await mkdtemp(join(tmpdir(), "vigil-controller-setup-only-")));
try {
  let ready = false;
  let setupCalls = 0;
  let quitCalls = 0;
  const controller = createVigilAppUpdateController({
    app: fakeApp(setupRoot),
    maintenanceReadiness: async () => setupRequiredReadiness(ready),
    quitForUpdate: () => {
      quitCalls += 1;
    },
    setupGuardian: async (request) => {
      setupCalls += 1;
      assert.equal(
        request.requireNormalUpdateCompatibility,
        true,
        "setup must reject an incompatible foreground parent command during read-only preflight, before requesting a password"
      );
      ready = true;
      return {
        ok: true,
        canceled: false,
        message: "Guardian setup complete.",
        readiness: setupRequiredReadiness(true)
      };
    }
  });
  const result = await controller.start() as Record<string, unknown>;
  assert.equal(result.ok, true);
  assert.equal(result.setupComplete, true);
  assert.equal(setupCalls, 1, "setup-only migration must invoke exactly one authorization transaction");
  assert.equal(quitCalls, 0, "setup-only migration must leave the running app online");
  assert.equal(
    existsSync(join(setupRoot, "updater", "update-status.json")),
    false,
    "setup-only migration must return before an update receipt or build attempt"
  );
} finally {
  await rm(setupRoot, { recursive: true, force: true });
}

const diagnosticRoot = await realpath(await mkdtemp(join(tmpdir(), "vigil-controller-guardian-diagnostic-")));
try {
  let setupCalls = 0;
  const exactMessage = "Vigil guardian check failed: check=guardian.predecessor.v5.parent-command detail=loaded v5 requires --vigil-background";
  const controller = createVigilAppUpdateController({
    app: fakeApp(diagnosticRoot),
    maintenanceReadiness: async () => setupRequiredReadiness(false),
    quitForUpdate: () => {
      throw new Error("The setup-only controller must not request quit.");
    },
    setupGuardian: async () => {
      setupCalls += 1;
      throw new Error(exactMessage);
    }
  });
  const result = await controller.start() as Record<string, unknown>;
  assert.equal(setupCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, exactMessage);
  assert.equal(result.errorCode, "guardian.predecessor.v5.parent-command");
  assert.equal(result.failedCheck, "Guardian check guardian.predecessor.v5.parent-command");
  assert.equal(result.errorDetail, "loaded v5 requires --vigil-background");
  assert.equal(existsSync(join(diagnosticRoot, "updater", "update-status.json")), false);
} finally {
  await rm(diagnosticRoot, { recursive: true, force: true });
}

assert.deepEqual(
  guardianCheckFailure("check=guardian.example.exact detail=the exact failed assertion"),
  {
    code: "guardian.example.exact",
    label: "Guardian check guardian.example.exact",
    status: "fail",
    message: "check=guardian.example.exact detail=the exact failed assertion",
    detail: "the exact failed assertion"
  }
);
