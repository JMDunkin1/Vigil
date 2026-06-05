import type { IncomingMessage, ServerResponse } from "node:http";
import { explainRuleDecision, type RuleSimulationInput } from "../ruleSimulator.js";
import type { SentinelState, UsageState } from "../types.js";
import { readBody, sendJson } from "./http.js";

interface RuleSimulatorApiContext {
  state: SentinelState;
  usage: UsageState;
}

export async function handleRuleSimulatorApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  { state, usage }: RuleSimulatorApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  if (url.pathname !== "/api/rules/explain" || !["GET", "POST"].includes(method)) return false;

  const input = method === "POST"
    ? await readBody(request) as RuleSimulationInput
    : Object.fromEntries(url.searchParams.entries()) as RuleSimulationInput;
  sendJson(response, 200, explainRuleDecision(state, usage, input));
  return true;
}
