const DATA_KEY = "__plistData";

interface PlistData {
  [DATA_KEY]: string;
}

type PlistValue = string | number | boolean | null | PlistData | PlistValue[] | PlistObject;

interface PlistObject {
  [key: string]: PlistValue;
}

type PlistToken =
  | { type: "open" | "close" | "self"; name: string }
  | { type: "text"; value: string };

type ParseResult = [PlistValue, number];

export function plistData(value: unknown): PlistData {
  const base64 = Buffer.isBuffer(value)
    ? value.toString("base64")
    : String(value || "").replace(/\s+/g, "");
  return { [DATA_KEY]: base64 };
}

export function isPlistData(value: unknown): value is PlistData {
  return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>)[DATA_KEY] === "string");
}

export function toPlist(value: unknown): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(value, 0)}
</plist>
`;
}

export function parsePlist(text: unknown): PlistValue {
  const tokens = tokenize(String(text || ""));
  const first = tokens.findIndex((token) => token.type === "open" || token.type === "self");
  if (first < 0) return {};
  const [value] = parseValue(tokens, first);
  return value;
}

function plistValue(value: unknown, level: number): string {
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

function tokenize(xml: string): PlistToken[] {
  const allowed = new Set(["plist", "dict", "array", "key", "string", "integer", "real", "true", "false", "data", "date"]);
  const tokens: PlistToken[] = [];
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

function parseValue(tokens: PlistToken[], index: number): ParseResult {
  const token = tokens[index];
  if (!token) return [null, index];

  if (token.type === "text") return [token.value, index + 1];

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

function parseDict(tokens: PlistToken[], index: number): ParseResult {
  const output: PlistObject = {};
  let cursor = nextStructural(tokens, index);
  while (tokens[cursor] && !isCloseToken(tokens[cursor], "dict")) {
    if (tokenName(tokens[cursor]) !== "key") break;
    const [key, afterKey] = parseScalar(tokens, cursor, "key");
    const [value, afterValue] = parseValue(tokens, nextStructural(tokens, afterKey));
    if (typeof key !== "string") break;
    output[key] = value;
    cursor = nextStructural(tokens, afterValue);
  }
  return [output, skipClose(tokens, cursor, "dict")];
}

function parseArray(tokens: PlistToken[], index: number): ParseResult {
  const output: PlistValue[] = [];
  let cursor = nextStructural(tokens, index);
  while (tokens[cursor] && !isCloseToken(tokens[cursor], "array")) {
    const [value, afterValue] = parseValue(tokens, cursor);
    output.push(value);
    cursor = nextStructural(tokens, afterValue);
  }
  return [output, skipClose(tokens, cursor, "array")];
}

function parseScalar(tokens: PlistToken[], index: number, name: string): ParseResult {
  if (tokens[index]?.type === "self") {
    if (name === "data") return [plistData(""), index + 1];
    return ["", index + 1];
  }

  let cursor = index + 1;
  let value = "";
  while (tokens[cursor] && !isCloseToken(tokens[cursor], name)) {
    const token = tokens[cursor];
    if (token?.type === "text") value += token.value;
    cursor += 1;
  }

  const text = unescapeXml(value.trim());
  if (name === "integer") return [Number.parseInt(text, 10) || 0, cursor + 1];
  if (name === "real") return [Number.parseFloat(text) || 0, cursor + 1];
  if (name === "data") return [plistData(text.replace(/\s+/g, "")), cursor + 1];
  return [text, cursor + 1];
}

function nextStructural(tokens: PlistToken[], index: number): number {
  let cursor = index;
  while (tokens[cursor]?.type === "text") cursor += 1;
  return cursor;
}

function skipClose(tokens: PlistToken[], index: number, name: string): number {
  const cursor = nextStructural(tokens, index);
  return isCloseToken(tokens[cursor], name) ? cursor + 1 : cursor;
}

function isCloseToken(token: PlistToken | undefined, name: string): boolean {
  return token?.type === "close" && token.name === name;
}

function tokenName(token: PlistToken | undefined): string | null {
  return token && token.type !== "text" ? token.name : null;
}

function escapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(value: unknown): string {
  return String(value ?? "")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
