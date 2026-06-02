export async function get(path) {
  const response = await fetch(path);
  return parseResponse(response);
}

export async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentinel-Intent": "sentinel-app"
    },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

export async function del(path) {
  const response = await fetch(path, {
    method: "DELETE",
    headers: { "X-Sentinel-Intent": "sentinel-app" }
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || "Request failed");
  return json;
}
