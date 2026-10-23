import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { youtubeConnectionPath } from "./youtubeConnection.js";
import type { YouTubeRequest } from "./youtubeLimits.js";

export interface YouTubeSharedConnection { endpoint: string; token: string }
export const youtubeSharedConnectionPath = () => join(dirname(youtubeConnectionPath()), "youtube-shared-connection.json");
export function validateYouTubeSharedConnection(value: unknown): YouTubeSharedConnection {
  const connection = value as Partial<YouTubeSharedConnection> | null;
  const url = new URL(connection?.endpoint || "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.pathname !== "/api/youtube" || !/^[a-f0-9]{64}$/.test(connection?.token || "")) {
    throw new Error("Invalid shared YouTube connection. Existing limits remain enforced.");
  }
  return { endpoint: url.href, token: connection!.token! };
}
export async function readYouTubeSharedConnection(): Promise<YouTubeSharedConnection | null> {
  try { return validateYouTubeSharedConnection(JSON.parse(await readFile(youtubeSharedConnectionPath(), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function sendSharedYouTube(connection: YouTubeSharedConnection, body: YouTubeRequest, fetcher = fetch) {
  const verified = validateYouTubeSharedConnection(connection);
  const response = await fetcher(verified.endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${verified.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000), redirect: "error"
  });
  if (!response.ok) throw new Error("The shared YouTube allowance is unavailable. Try again when connected.");
  const reply = await response.json() as ReturnType<typeof import("./youtubeLimits.js").youtubeAction>;
  if (typeof reply?.ok !== "boolean" || !/^\d{4}-\d{2}-\d{2}$/.test(reply.day || "")
      || !Array.isArray(reply.slots) || reply.slots.length !== 4 || !Number.isFinite(reply.serverTime)
      || !Number.isFinite(reply.usedMs) || !reply.grace) throw new Error("Invalid shared YouTube allowance reply.");
  return reply;
}
