import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { createAppUpdatePanel } from "../public/app-update.js";
import type { ControlElement, UnknownRecord } from "../public/app-model.js";
import { atomicInstallBuiltApp } from "../scripts/update-packaged-app.mjs";

interface Bridge {
  status(options?: { checkRemote?: boolean; instanceSecret?: string }): Promise<unknown>;
  start(): Promise<unknown>;
}

interface Invocation {
  channel: string;
  args: unknown[];
}

interface AppearanceBridge {
  getIconTheme(): Promise<unknown>;
  setIconTheme(theme: string): Promise<unknown>;
}

interface ApiBridge {
  request(path: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<unknown>;
}

const sourceRoot = existsSync(join(process.cwd(), "app", "main.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const preloadSource = await readFile(join(sourceRoot, "app", "preload.cjs"), "utf8");
const mainSource = await readFile(join(sourceRoot, "app", "main.ts"), "utf8");
const updaterSource = await readFile(join(sourceRoot, "app", "updater.ts"), "utf8");
const updateScriptSource = await readFile(join(sourceRoot, "scripts", "update-packaged-app.mts"), "utf8");
const exposed = new Map<string, unknown>();
const invocations: Invocation[] = [];

vm.runInNewContext(preloadSource, {
  require(specifier: string) {
    assert.equal(specifier, "electron");
    return {
      contextBridge: {
        exposeInMainWorld(name: string, value: unknown) {
          exposed.set(name, value);
        }
      },
      ipcRenderer: {
        send() {},
        async invoke(channel: string, ...args: unknown[]) {
          invocations.push({ channel, args });
          return { ok: true };
        }
      }
    };
  },
  window: {
    addEventListener(_name: string, listener: () => void) {
      listener();
    }
  },
  document: {
    documentElement: {
      classList: { add() {} }
    }
  }
});

const preloadBridge = exposed.get("vigilAppUpdate") as Bridge | undefined;
assert.ok(preloadBridge, "preload should expose the app update bridge");
await preloadBridge.status({ checkRemote: true, instanceSecret: "must-not-cross-the-bridge" });
await preloadBridge.start();
assert.equal(invocations[0]?.channel, "vigil:app-update-status");
assert.deepEqual(Object.keys(invocations[0]?.args[0] as object), ["checkRemote"]);
assert.equal((invocations[0]?.args[0] as { checkRemote?: unknown }).checkRemote, true);
assert.equal(invocations[1]?.channel, "vigil:app-update-start");
assert.equal(invocations[1]?.args.length, 0);
const appearanceBridge = exposed.get("vigilAppearance") as AppearanceBridge | undefined;
assert.ok(appearanceBridge, "preload should expose the icon appearance bridge");
await appearanceBridge.getIconTheme();
await appearanceBridge.setIconTheme("sacred-heart");
assert.equal(invocations[2]?.channel, "vigil:icon-theme-get");
assert.equal(invocations[3]?.channel, "vigil:icon-theme-set");
assert.deepEqual(invocations[3]?.args, ["sacred-heart"]);
const apiBridge = exposed.get("vigilApi") as ApiBridge | undefined;
assert.ok(apiBridge, "preload should expose the private API bridge");
await apiBridge.request("/api/state", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
});
assert.equal(invocations[4]?.channel, "vigil:api-request");
assert.equal(JSON.stringify(invocations[4]?.args), JSON.stringify([{
  path: "/api/state",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
}]));
assert.match(mainSource, /ipcMain\.handle\("vigil:api-request", handlePrivateApiRequest\)/u);
assert.match(mainSource, /APP_URL = `\$\{APP_SCHEME\}:\/\/\$\{APP_HOST\}\//u);
assert.match(
  mainSource,
  /startVigilCompanionServer\(\{ appUpdate, port: companionServerPort\(\) \}\)/u,
  "the packaged app must preserve the restricted companion and MDM listener on the migrated port"
);
assert.doesNotMatch(mainSource, /startVigilServer\(/u, "the packaged app must not expose the full app server");
assert.match(mainSource, /!app\.isPackaged && await companionServerIsHealthy\(\)/u, "development may reuse only a verified existing companion listener");
assert.match(mainSource, /maxAgeSeconds <= 0 \? 1 : Math\.floor\(Date\.now\(\) \/ 1000\) \+ maxAgeSeconds/u, "positive Max-Age cookies must survive an app restart");
assert.match(
  mainSource,
  /Object\.entries\(response\.headers\)\.filter\(\(\[name\]\) => name\.toLowerCase\(\) !== "set-cookie"\)/u,
  "the private API bridge must not expose session cookies to the renderer"
);
assert.match(mainSource, /ipcMain\.handle\("vigil:app-update-status", handleAppUpdateStatus\)/u);
assert.match(mainSource, /ipcMain\.handle\("vigil:app-update-start", handleAppUpdateStart\)/u);
assert.match(mainSource, /ipcMain\.handle\("vigil:icon-theme-get", handleIconThemeGet\)/u);
assert.match(mainSource, /ipcMain\.handle\("vigil:icon-theme-set", handleIconThemeSet\)/u);
assert.doesNotMatch(mainSource, /cursorAuraWindow|CURSOR_AURA_MARGIN|vigil:cursor-aura-update/u, "the cursor glow must not create an oversized native window around Vigil");
assert.equal(exposed.has("vigilCursorAura"), false, "the preload must not expose a bridge for a removed native aura window");
assert.match(mainSource, /ICON_THEMES = \["jerusalem-cross", "sacred-heart", "saint-michael"\]/u);
assert.match(mainSource, /!event\.senderFrame \|\| !isTrustedAppUrl\(event\.senderFrame\.url\)/u);
assert.doesNotMatch(mainSource, /\/api\/app-update\/(?:status|start)/u);
assert.match(updaterSource, /launchAgentRepoRoot\(app\)/u);
assert.match(updateScriptSource, /-c\.directories\.output=dist\/update-mac\.noindex/u);
assert.doesNotMatch(updateScriptSource, /"build:mac"/u);

const installRoot = await mkdtemp(join(tmpdir(), "vigil-app-update-install-"));
try {
  const stageRoot = join(installRoot, "dist", "update-mac.noindex");
  const builtApp = join(stageRoot, "mac-arm64", "Vigil.app");
  const installedApp = join(installRoot, "dist", "mac.noindex", "mac-arm64", "Vigil.app");
  await mkdir(builtApp, { recursive: true });
  await mkdir(installedApp, { recursive: true });
  await writeFile(join(builtApp, "version.txt"), "new");
  await writeFile(join(installedApp, "version.txt"), "old");

  const rolledBack = await atomicInstallBuiltApp(builtApp, installedApp, stageRoot);
  assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "new");
  assert.equal(await readFile(join(`${installedApp}.vigil-previous`, "version.txt"), "utf8"), "old");
  await rolledBack.rollback();
  assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "old");
  assert.equal(existsSync(stageRoot), false);

  await mkdir(builtApp, { recursive: true });
  await writeFile(join(builtApp, "version.txt"), "newer");
  const finalized = await atomicInstallBuiltApp(builtApp, installedApp, stageRoot);
  await finalized.finalize();
  assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "newer");
  assert.equal(existsSync(`${installedApp}.vigil-previous`), false);
  assert.equal(existsSync(stageRoot), false);
} finally {
  await rm(installRoot, { recursive: true, force: true });
}

const originalWindow = globalThis.window;
const controls = new Map<string, ControlElement>();
let buttonClick: (() => void) | null = null;
let getCalls = 0;
let postCalls = 0;
let statusCalls = 0;
let startCalls = 0;
let checkedRemote: boolean | undefined;
let rendererStatus: UnknownRecord = {
  ok: true,
  supported: true,
  updateAvailable: true,
  appBundleOutdated: true,
  dirty: false,
  behind: 0,
  message: "Installed app is behind this checkout"
};
let rendererStartResult: UnknownRecord = {
  ok: true,
  supported: true,
  phase: "starting",
  message: "Vigil will reopen"
};
const rendererBridge = {
  async status(options: { checkRemote?: boolean } = {}) {
    statusCalls += 1;
    checkedRemote = options.checkRemote;
    return rendererStatus;
  },
  async start() {
    startCalls += 1;
    return rendererStartResult;
  }
};

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { vigilAppUpdate: rendererBridge }
});

try {
  for (const id of ["checkAppUpdate", "appUpdateStatus", "appUpdateMeta"]) {
    controls.set(`#${id}`, fakeControl(id === "checkAppUpdate" ? (listener) => {
      buttonClick = listener;
    } : undefined));
  }
  const panel = createAppUpdatePanel({
    $: (selector) => {
      const control = controls.get(selector);
      assert.ok(control, `missing fake control ${selector}`);
      return control;
    },
    get: async <T = unknown,>(_path: string) => {
      getCalls += 1;
      return {} as T;
    },
    post: async <T = unknown,>(_path: string, _body: unknown) => {
      postCalls += 1;
      return {} as T;
    },
    toast() {},
    errorMessage: (error) => error instanceof Error ? error.message : String(error)
  });
  panel.bind();
  await panel.refreshStatus(true);
  assert.equal(statusCalls, 1);
  assert.equal(checkedRemote, true);
  assert.equal(getCalls, 0);
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Install Update");

  const click = buttonClick as (() => void) | null;
  assert.ok(click);
  click();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(startCalls, 1);
  assert.equal(postCalls, 0);

  rendererStatus = {
    ok: true,
    supported: true,
    updateAvailable: false,
    appBundleOutdated: false,
    dirty: true,
    localChanges: false,
    behind: 1,
    remoteCheckOk: true,
    message: "Local changes are running"
  };
  await panel.refreshStatus(true);
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Check for Updates");
  click();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(startCalls, 1, "a dirty checkout already represented by the app must not offer a rejected remote update");

  rendererStatus = {
    ok: true,
    supported: true,
    updateAvailable: true,
    dirty: true,
    localChanges: true,
    behind: 0,
    message: "Local changes ready to run"
  };
  await panel.refreshStatus(false);
  rendererStartResult = {
    ...rendererStatus,
    running: true,
    updateAvailable: false,
    phase: "building",
    message: "Building local changes"
  };
  click();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(startCalls, 2);
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_100));
  assert.equal(controls.get("#checkAppUpdate")?.disabled, false, "a completed or failed local build must refresh the cached running state");
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Run Local Changes");
} finally {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow
  });
}

function fakeControl(onClick?: (listener: () => void) => void): ControlElement {
  const classes = new Set<string>();
  return {
    textContent: "",
    disabled: false,
    classList: {
      add: (...tokens: string[]) => tokens.forEach((token) => classes.add(token)),
      remove: (...tokens: string[]) => tokens.forEach((token) => classes.delete(token)),
      toggle: (token: string, force?: boolean) => {
        const enabled = force ?? !classes.has(token);
        if (enabled) classes.add(token);
        else classes.delete(token);
        return enabled;
      }
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== "click" || !onClick) return;
      onClick(() => {
        if (typeof listener === "function") listener(new Event("click"));
        else listener.handleEvent(new Event("click"));
      });
    }
  } as unknown as ControlElement;
}
