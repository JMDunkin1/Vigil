export async function get<T = unknown>(path: string): Promise<T> {
  const response = await fetch(path);
  return parseResponse<T>(response);
}

export async function post<T = unknown>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentinel-Intent": "sentinel-app"
    },
    body: JSON.stringify(body)
  });
  return parseResponse<T>(response);
}

export async function del<T = unknown>(path: string): Promise<T> {
  const response = await fetch(path, {
    method: "DELETE",
    headers: { "X-Sentinel-Intent": "sentinel-app" }
  });
  return parseResponse<T>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const json: unknown = await response.json();
  if (!response.ok) {
    const record = json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
    const message = "error" in record ? String(record.error) : "Request failed";
    throw new Error(message);
  }
  return json as T;
}
