export async function get<T = unknown>(path: string): Promise<T> {
  const response = await fetch(path, { headers: journalHeaders(path) });
  return parseResponse<T>(response, path);
}

export async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vigil-Intent": "vigil-app",
      ...journalHeaders(path)
    },
    body: JSON.stringify(body)
  });
  const result = await parseResponse<T>(response, path);
  if (path === "/api/intentional-use/journal/lock" || path === "/api/intentional-use/journal/password") {
    clearJournalSession();
  }
  return result;
}

export async function del<T = unknown>(path: string): Promise<T> {
  const response = await fetch(path, {
    method: "DELETE",
    headers: {
      "X-Vigil-Intent": "vigil-app",
      ...journalHeaders(path)
    }
  });
  return parseResponse<T>(response, path);
}

const JOURNAL_TOKEN_KEY = "vigil-journal-token";
const JOURNAL_EXPIRY_KEY = "vigil-journal-expires-at";

export interface JournalSession {
  token?: string;
  expiresAt?: string;
}

export function storeJournalSession(session: JournalSession | null | undefined): void {
  const token = String(session?.token || "");
  const expiresAt = String(session?.expiresAt || "");
  if (!token || !expiresAt || Date.parse(expiresAt) <= Date.now()) {
    clearJournalSession();
    return;
  }
  try {
    sessionStorage.setItem(JOURNAL_TOKEN_KEY, token);
    sessionStorage.setItem(JOURNAL_EXPIRY_KEY, expiresAt);
  } catch {
    clearJournalSession();
  }
}

export function clearJournalSession(): void {
  try {
    sessionStorage.removeItem(JOURNAL_TOKEN_KEY);
    sessionStorage.removeItem(JOURNAL_EXPIRY_KEY);
  } catch {
  }
}

export function journalSessionActive(): boolean {
  return Boolean(activeJournalToken());
}

function activeJournalToken(): string {
  try {
    const token = sessionStorage.getItem(JOURNAL_TOKEN_KEY) || "";
    const expiresAt = sessionStorage.getItem(JOURNAL_EXPIRY_KEY) || "";
    if (!token || !expiresAt || Date.parse(expiresAt) <= Date.now()) {
      clearJournalSession();
      return "";
    }
    return token;
  } catch {
    return "";
  }
}

function journalHeaders(path: string): Record<string, string> {
  if (!path.startsWith("/api/intentional-use/journal")) return {};
  const token = activeJournalToken();
  return token ? { "X-Vigil-Journal-Token": token } : {};
}

async function parseResponse<T>(response: Response, path: string): Promise<T> {
  const json: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path.startsWith("/api/intentional-use/journal")) clearJournalSession();
    const record = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
    const message = "error" in record ? String(record.error) : "Request failed";
    throw new Error(message);
  }
  return json as T;
}
