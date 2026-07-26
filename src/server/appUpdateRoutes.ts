import type { IncomingMessage, ServerResponse } from "node:http";
import { localControlRequestGuard } from "../apiSecurity.js";
import { sendJson } from "./http.js";

export interface AppUpdateController {
  status(options?: { checkRemote?: boolean }): Promise<unknown>;
  start(): Promise<unknown>;
  relaunch(): Promise<unknown>;
}

interface AppUpdateRouteContext {
  controller?: AppUpdateController | null;
}

export async function handleAppUpdateApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  { controller = null }: AppUpdateRouteContext = {}
): Promise<boolean> {
  const method = request.method || "GET";
  const path = new URL(request.url || "/", "http://localhost").pathname;
  if (!["/api/app-update/status", "/api/app-update/start", "/api/app-relaunch"].includes(path)) return false;

  if (path === "/api/app-relaunch") {
    const guard = localControlRequestGuard({
      method,
      headers: request.headers,
      remoteAddress: request.socket.remoteAddress
    });
    if (!guard.ok) {
      sendJson(response, guard.status || 403, { ok: false, error: guard.error || "Forbidden" });
      return true;
    }
  }

  if (!controller) {
    sendJson(response, method === "GET" ? 200 : 409, {
      ok: method === "GET",
      supported: false,
      running: false,
      message: "App updates are available from the packaged Vigil app."
    });
    return true;
  }

  if (method === "GET" && path === "/api/app-update/status") {
    const query = new URL(request.url || "/", "http://localhost").searchParams;
    sendJson(response, 200, await controller.status({ checkRemote: query.get("check") === "1" }));
    return true;
  }

  if (method === "POST" && path === "/api/app-update/start") {
    const result = await controller.start();
    const ok = result && typeof result === "object" && !Array.isArray(result) && (result as { ok?: unknown }).ok === true;
    sendJson(response, ok ? 202 : 409, result);
    return true;
  }

  if (method === "POST" && path === "/api/app-relaunch") {
    const result = await controller.relaunch();
    const ok = result && typeof result === "object" && !Array.isArray(result) && (result as { ok?: unknown }).ok === true;
    sendJson(response, ok ? 202 : 409, result);
    return true;
  }

  sendJson(response, 405, { error: "Method not allowed" });
  return true;
}
