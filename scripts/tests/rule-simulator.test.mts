import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE } from "../../src/apiSecurity.js";
import { defaultState, SOFT_BLOCK_PROFILE_ID } from "../../src/defaults.js";
import { explainRuleDecision } from "../../src/ruleSimulator.js";
import { handleRuleSimulatorApiRoute } from "../../src/server/ruleSimulatorRoutes.js";
import { dateKey } from "../../src/time.js";
import type { Profile, SentinelState, Session, UsageState } from "../../src/types.js";

const now = new Date("2026-06-04T15:30:00.000Z");

{
  const state = defaultState();
  const result = explainRuleDecision(state, {}, {
    url: "https://pornhub.com/watch",
    at: now
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reasonCode, "baseline-site");
  assert.equal(result.policy?.kind, "baseline");
  assert.match(result.reason, /baseline Normal/);
}

{
  const state = defaultState();
  startSession(state, "default", ["computer"]);
  const result = explainRuleDecision(state, {}, {
    app: "Google Chrome",
    url: "https://www.youtube.com/shorts/demo",
    at: now
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reasonCode, "content-filter");
  assert.equal(result.match?.label, "YouTube Shorts");
}

{
  const state = defaultState();
  state.settings.intentionalUseEnabled = false;
  startSession(state, "default", ["phone"]);

  const computer = explainRuleDecision(state, {}, {
    url: "https://reddit.com/",
    device: "computer",
    at: now
  });
  const phone = explainRuleDecision(state, {}, {
    url: "https://reddit.com/",
    device: "phone",
    at: now
  });

  assert.equal(computer.allowed, true);
  assert.equal(phone.blocked, true);
  assert.equal(phone.policy?.kind, "manual");
  assert.equal(phone.target.device, "phone");
}

{
  const state = defaultState();
  state.settings.intentionalUseEnabled = false;
  state.appLocks = [{
    id: "discord-lock",
    name: "Discord lock",
    enabled: true,
    lockLevel: "deep",
    days: [now.getDay()],
    apps: ["Discord"],
    sites: [],
    unlocksAllowed: 0,
    unlockMinutes: 10,
    delaySeconds: 0
  }];

  const result = explainRuleDecision(state, {}, {
    app: "Discord",
    at: now
  });

  assert.equal(result.blocked, true);
  assert.equal(result.policy?.kind, "app-lock");
  assert.equal(result.reasonCode, "app-lock-app");
  assert.match(result.reason, /Discord lock/);
}

{
  const state = defaultState();
  state.settings.intentionalUseEnabled = false;
  state.limitRules = [{
    id: "video-limit",
    name: "Video limit",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: [now.getDay()],
    apps: [],
    sites: ["youtube.com"],
    limitMinutes: 5,
    unlocksAllowed: 0,
    blockMinutes: 30
  }];
  const usage: UsageState = {
    [dateKey(now)]: {
      totalSeconds: 600,
      apps: {},
      sites: { "youtube.com": 600 },
      opens: { apps: {}, sites: {} },
      devices: {}
    }
  };

  const result = explainRuleDecision(state, usage, {
    url: "https://youtube.com/watch?v=demo",
    at: now
  });

  assert.equal(result.blocked, true);
  assert.equal(result.policy?.kind, "limit");
  assert.equal(result.reasonCode, "limit-site");
  assert.equal(state.limitBlocks.length, 0);
}

{
  const state = defaultState();
  state.settings.activeProfileId = "normal";
  state.settings.baselineProfileId = "normal";

  const result = explainRuleDecision(state, {}, {
    url: "https://youtube.com/shorts/demo",
    at: now
  });

  assert.equal(result.blocked, false);
  assert.equal(result.paused, true);
  assert.equal(result.reasonCode, "intentional-use");
  assert.equal(state.intentionalUse.pauses.length, 0);
}

{
  const state = defaultState();
  state.settings.strictBypassProtectionEnabled = true;
  startSession(state, SOFT_BLOCK_PROFILE_ID, ["computer"], "deep");

  const result = explainRuleDecision(state, {}, {
    app: "Google Chrome",
    url: "chrome://extensions",
    at: now
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reasonCode, "browser-control");
  assert.equal(result.match?.type, "browser-control");
}

{
  const state = defaultState();
  const response = mockResponse();
  const handled = await handleRuleSimulatorApiRoute(
    mockRequest("GET", "/api/rules/explain?url=https%3A%2F%2Fpornhub.com%2Fwatch", {
      host: "127.0.0.1:8787"
    }),
    response,
    new URL("http://127.0.0.1:8787/api/rules/explain?url=https%3A%2F%2Fpornhub.com%2Fwatch"),
    { state, usage: {} }
  );

  assert.equal(handled, true);
  assert.equal(response.statusCodeValue, 200);
  const body = JSON.parse(response.bodyText) as { blocked?: boolean; policy?: { kind?: string } };
  assert.equal(body.blocked, true);
  assert.equal(body.policy?.kind, "baseline");
}

{
  const state = defaultState();
  const response = mockResponse();
  await handleRuleSimulatorApiRoute(
    mockRequest("POST", "/api/rules/explain", {
      host: "127.0.0.1:8787",
      "content-type": "application/json",
      [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
    }, {
      url: "https://pornhub.com/watch",
      at: now.toISOString()
    }),
    response,
    new URL("http://127.0.0.1:8787/api/rules/explain"),
    { state, usage: {} }
  );

  assert.equal(response.statusCodeValue, 200);
}

function startSession(state: SentinelState, profileId: string, deviceTargets: Array<"computer" | "phone">, lockLevel: "light" | "deep" = "deep"): void {
  const profile = state.profiles.find((item) => item.id === profileId) as Profile;
  const session: Session = {
    id: `session-${profileId}-${deviceTargets.join("-")}`,
    title: profile.name,
    mode: "focus",
    profileId,
    lockLevel,
    startedAt: "2026-06-04T15:00:00.000Z",
    endsAt: "2026-06-04T17:00:00.000Z",
    canEndEarly: false,
    source: "manual",
    deviceTargets,
    profileSnapshot: profile
  };
  state.activeSessions = {
    computer: deviceTargets.includes("computer") ? session : null,
    phone: deviceTargets.includes("phone") ? session : null
  };
  state.activeSession = state.activeSessions.computer || null;
}

function mockRequest(method: string, url: string, headers: Record<string, string>, body: object = {}): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, { method, url, headers }) as IncomingMessage;
}

interface MockResponse {
  statusCodeValue?: number;
  bodyText: string;
  headersValue: Record<string, unknown>;
  writeHead(statusCode: number, headers?: Record<string, unknown>): MockResponse;
  end(chunk?: unknown): MockResponse;
}

function mockResponse(): ServerResponse & MockResponse {
  const target: MockResponse = {
    bodyText: "",
    headersValue: {},
    writeHead(statusCode: number, headers: Record<string, unknown> = {}) {
      this.statusCodeValue = statusCode;
      this.headersValue = headers;
      return this;
    },
    end(chunk?: unknown) {
      this.bodyText += chunk ? String(chunk) : "";
      return this;
    }
  };
  return target as ServerResponse & MockResponse;
}
