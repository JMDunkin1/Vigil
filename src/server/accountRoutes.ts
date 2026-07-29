import type { IncomingMessage, ServerResponse } from "node:http";
import { accountSession, createAccount, signInAccount, signOutAccount } from "../auth.js";
import { errorStatus, readBody, sendJson, serializeError } from "./http.js";

export async function handleAccountApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  path: string
): Promise<boolean> {
  const method = request.method || "GET";

  try {
    if (method === "GET" && path === "/api/account/session") {
      sendJson(response, 200, await accountSession(request), { "Cache-Control": "no-store" });
      return true;
    }

    if (method === "POST" && path === "/api/account/signup") {
      const result = await createAccount(await readBody(request), request);
      sendJson(response, 201, result.session, { "Cache-Control": "no-store", "Set-Cookie": result.cookie });
      return true;
    }

    if (method === "POST" && path === "/api/account/login") {
      const result = await signInAccount(await readBody(request), request);
      sendJson(response, 200, result.session, { "Cache-Control": "no-store", "Set-Cookie": result.cookie });
      return true;
    }

    if (method === "POST" && path === "/api/account/logout") {
      const current = await accountSession(request);
      const signedOut = current.mode === "local"
        ? current
        : { ...current, authenticated: false, user: null };
      sendJson(response, 200, signedOut, { "Cache-Control": "no-store", "Set-Cookie": signOutAccount(request) });
      return true;
    }
  } catch (error) {
    sendJson(response, errorStatus(error), serializeError(error), { "Cache-Control": "no-store" });
    return true;
  }

  return false;
}
