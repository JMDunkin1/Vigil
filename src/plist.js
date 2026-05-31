const DATA_KEY = "__plistData";

export function plistData(value) {
  const base64 = Buffer.isBuffer(value)
    ? value.toString("base64")
    : String(value || "").replace(/\s+/g, "");
  return { [DATA_KEY]: base64 };
}

export function isPlistData(value) {
  return Boolean(value && typeof value === "object" && typeof value[DATA_KEY] === "string");
}

export function toPlist(value) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(value, 0)}
</plist>
`;
}

export function parsePlist(text) {
  const tokens = tokenize(String(text || ""));
  const first = tokens.findIndex((token) => token.type === "open" || token.type === "self");
  if (first < 0) return {};
  const [value] = parseValue(tokens, first);
  return value;
}

function plistValue(value, level) {
  const indent = "  ".repeat(level);
  if (isPlistData(value)) {
    const data = value[DATA_KEY].replace(/(.{1,68})/g, `${indent}  $1\n`).trimEnd();
    return data ? `${indent}<data>\n${data}\n${indent}</data>` : `${indent}<data/>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}<array/>`;
    return `${indent}<array>\n${value.map((item) => plistValue(item, level + 1)).join("\n")}\n${indent}</array>`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined && item !== null);
    if (!entries.length) return `${indent}<dict/>`;
    return `${indent}<dict>\n${entries.map(([key, item]) => `${indent}  <key>${escapeXml(key)}</key>\n${plistValue(item, level + 1)}`).join("\n")}\n${indent}</dict>`;
  }
  if (typeof value === "boolean") return `${indent}<${value ? "true" : "false"}/>`;
  if (Number.isInteger(value)) return `${indent}<integer>${value}</integer>`;
  if (typeof value === "number" && Number.isFinite(value)) return `${indent}<real>${value}</real>`;
  return `${indent}<string>${escapeXml(value)}</string>`;
}

function tokenize(xml) {
  const allowed = new Set(["plist", "dict", "array", "key", "string", "integer", "real", "true", "false", "data", "date"]);
  const tokens = [];
  const pattern = /<\?[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w.-]*)([^>]*)>|([^<]+)/g;
  let match;
  while ((match = pattern.exec(xml))) {
    if (match[4] !== undefined) {
      if (match[4].trim()) tokens.push({ type: "text", value: match[4] });
      continue;
    }

    const name = match[2];
    if (!allowed.has(name)) continue;
    const closing = match[1] === "/";
    const self = /\/\s*$/.test(match[3] || "");
    tokens.push({
      type: closing ? "close" : (self ? "self" : "open"),
      name
    });
  }
  return tokens;
}

function parseValue(tokens, index) {
  const token = tokens[index];
  if (!token) return [null, index];

  if (token.type === "self") {
    if (token.name === "dict") return [{}, index + 1];
    if (token.name === "array") return [[], index + 1];
    if (token.name === "true") return [true, index + 1];
    if (token.name === "false") return [false, index + 1];
    if (token.name === "data") return [plistData(""), index + 1];
    return ["", index + 1];
  }

  if (token.name === "plist") {
    const next = nextStructural(tokens, index + 1);
    const [value, afterValue] = parseValue(tokens, next);
    return [value, skipClose(tokens, afterValue, "plist")];
  }

  if (token.name === "dict") return parseDict(tokens, index + 1);
  if (token.name === "array") return parseArray(tokens, index + 1);
  if (token.name === "true") return [true, skipClose(tokens, index + 1, "true")];
  if (token.name === "false") return [false, skipClose(tokens, index + 1, "false")];
  if (["key", "string", "integer", "real", "data", "date"].includes(token.name)) {
    return parseScalar(tokens, index, token.name);
  }

  return [null, index + 1];
}

function parseDict(tokens, index) {
  const output = {};
  let cursor = nextStructural(tokens, index);
  while (tokens[cursor] && !(tokens[cursor].type === "close" && tokens[cursor].name === "dict")) {
    if (tokens[cursor]?.name !== "key") break;
    const [key, afterKey] = parseScalar(tokens, cursor, "key");
    const [value, afterValue] = parseValue(tokens, nextStructural(tokens, afterKey));
    output[key] = value;
    cursor = nextStructural(tokens, afterValue);
  }
  return [output, skipClose(tokens, cursor, "dict")];
}

function parseArray(tokens, index) {
  const output = [];
  let cursor = nextStructural(tokens, index);
  while (tokens[cursor] && !(tokens[cursor].type === "close" && tokens[cursor].name === "array")) {
    const [value, afterValue] = parseValue(tokens, cursor);
    output.push(value);
    cursor = nextStructural(tokens, afterValue);
  }
  return [output, skipClose(tokens, cursor, "array")];
}

function parseScalar(tokens, index, name) {
  if (tokens[index]?.type === "self") {
    if (name === "data") return [plistData(""), index + 1];
    return ["", index + 1];
  }

  let cursor = index + 1;
  let value = "";
  while (tokens[cursor] && !(tokens[cursor].type === "close" && tokens[cursor].name === name)) {
    if (tokens[cursor].type === "text") value += tokens[cursor].value;
    cursor += 1;
  }

  const text = unescapeXml(value.trim());
  if (name === "integer") return [Number.parseInt(text, 10) || 0, cursor + 1];
  if (name === "real") return [Number.parseFloat(text) || 0, cursor + 1];
  if (name === "data") return [plistData(text.replace(/\s+/g, "")), cursor + 1];
  return [text, cursor + 1];
}

function nextStructural(tokens, index) {
  let cursor = index;
  while (tokens[cursor]?.type === "text") cursor += 1;
  return cursor;
}

function skipClose(tokens, index, name) {
  const cursor = nextStructural(tokens, index);
  return tokens[cursor]?.type === "close" && tokens[cursor]?.name === name ? cursor + 1 : cursor;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value) {
  return String(value ?? "")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
