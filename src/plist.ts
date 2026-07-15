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
const MAX_PLIST_BYTES = 1024 * 1024;
const MAX_PLIST_TOKENS = 100_000;
const MAX_PLIST_DEPTH = 64;
const FORBIDDEN_DICTIONARY_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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
  const source = String(text || "");
  if (Buffer.byteLength(source, "utf8") > MAX_PLIST_BYTES) throw new Error("Property list exceeds the 1 MiB limit.");
  const tokens = tokenize(source);
  if (!tokens.length || !["plist", "dict"].includes(tokenName(tokens[0]) || "")) throw new Error("Property list must have a plist or dict root.");
  const [value, cursor] = parseValue(tokens, 0, 0);
  if (nextStructural(tokens, cursor) !== tokens.length) throw new Error("Property list contains trailing or malformed content.");
  if (!value || typeof value !== "object" || Array.isArray(value) || isPlistData(value)) throw new Error("Property list root must be a dictionary.");
  return value;
}

export function plistStringForKey(text: unknown, key: string): string {
  const value = findUniqueValueForKey(parsePlist(text), key);
  return typeof value === "string" ? value : "";
}

function findUniqueValueForKey(value: PlistValue, key: string): PlistValue | undefined {
  const matches: PlistValue[] = [];
  visit(value);
  if (matches.length > 1) throw new Error(`Ambiguous nested property list key: ${key}.`);
  return matches[0];

  function visit(item: PlistValue): void {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object" || isPlistData(item)) return;
    if (Object.hasOwn(item, key)) matches.push(item[key]);
    for (const child of Object.values(item)) visit(child);
  }
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
  if (/<!ENTITY\b/iu.test(xml) || /<!DOCTYPE[^>]*\[/iu.test(xml)) throw new Error("Property list entities are not allowed.");
  const withoutMetadata = xml
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<\?xml\s+[^?]*\?>/giu, "")
    .replace(/<!DOCTYPE\s+plist\s+PUBLIC\s+(["'])-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN\1\s+(["'])https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd\2\s*>/giu, "");
  if (/<!|<\?/u.test(withoutMetadata)) throw new Error("Unsupported property list declaration.");
  const tokens: PlistToken[] = [];
  const pattern = /<(\/?)([A-Za-z][\w.-]*)([^>]*)>|([^<]+)/gu;
  let match;
  let cursor = 0;
  while ((match = pattern.exec(withoutMetadata))) {
    if (withoutMetadata.slice(cursor, match.index).trim()) throw new Error("Malformed property list XML.");
    cursor = pattern.lastIndex;
    if (match[4] !== undefined) {
      if (match[4].trim()) tokens.push({ type: "text", value: match[4] });
      continue;
    }

    const name = match[2];
    if (!allowed.has(name)) throw new Error(`Unsupported property list element: ${name}.`);
    const closing = match[1] === "/";
    const self = /\/\s*$/.test(match[3] || "");
    const attributes = String(match[3] || "").replace(/\/\s*$/u, "").trim();
    if (attributes && !(name === "plist" && /^version\s*=\s*(["'])1\.0\1$/u.test(attributes))) {
      throw new Error(`Unsupported attributes on property list element: ${name}.`);
    }
    if (closing && (attributes || self)) throw new Error("Malformed property list closing element.");
    tokens.push({
      type: closing ? "close" : (self ? "self" : "open"),
      name
    });
    if (tokens.length > MAX_PLIST_TOKENS) throw new Error("Property list exceeds the token limit.");
  }
  if (withoutMetadata.slice(cursor).trim()) throw new Error("Malformed property list XML.");
  return tokens;
}

function parseValue(tokens: PlistToken[], index: number, depth: number): ParseResult {
  if (depth > MAX_PLIST_DEPTH) throw new Error("Property list exceeds the nesting depth limit.");
  const token = tokens[index];
  if (!token || token.type === "close") throw new Error("Property list value is missing or malformed.");

  if (token.type === "text") return [token.value, index + 1];

  if (token.type === "self") {
    if (token.name === "dict") return [Object.create(null) as PlistObject, index + 1];
    if (token.name === "array") return [[], index + 1];
    if (token.name === "true") return [true, index + 1];
    if (token.name === "false") return [false, index + 1];
    if (token.name === "data") return [plistData(""), index + 1];
    return ["", index + 1];
  }

  if (token.name === "plist") {
    const next = nextStructural(tokens, index + 1);
    const [value, afterValue] = parseValue(tokens, next, depth + 1);
    const after = requireClose(tokens, afterValue, "plist");
    return [value, after];
  }

  if (token.name === "dict") return parseDict(tokens, index + 1, depth + 1);
  if (token.name === "array") return parseArray(tokens, index + 1, depth + 1);
  if (token.name === "true" || token.name === "false") throw new Error("Property list booleans must use empty self-closing elements.");
  if (["key", "string", "integer", "real", "data", "date"].includes(token.name)) {
    return parseScalar(tokens, index, token.name);
  }

  return [null, index + 1];
}

function parseDict(tokens: PlistToken[], index: number, depth: number): ParseResult {
  const output = Object.create(null) as PlistObject;
  let cursor = nextStructural(tokens, index);
  while (tokens[cursor] && !isCloseToken(tokens[cursor], "dict")) {
    if (tokenName(tokens[cursor]) !== "key") throw new Error("Property list dictionary contains a value without a key.");
    const [key, afterKey] = parseScalar(tokens, cursor, "key");
    const [value, afterValue] = parseValue(tokens, nextStructural(tokens, afterKey), depth);
    if (typeof key !== "string") throw new Error("Property list dictionary key must be a string.");
    if (FORBIDDEN_DICTIONARY_KEYS.has(key)) throw new Error(`Forbidden property list dictionary key: ${key}.`);
    if (Object.hasOwn(output, key)) throw new Error(`Duplicate property list key: ${key}.`);
    output[key] = value;
    cursor = nextStructural(tokens, afterValue);
  }
  return [output, requireClose(tokens, cursor, "dict")];
}

function parseArray(tokens: PlistToken[], index: number, depth: number): ParseResult {
  const output: PlistValue[] = [];
  let cursor = nextStructural(tokens, index);
  while (tokens[cursor] && !isCloseToken(tokens[cursor], "array")) {
    const [value, afterValue] = parseValue(tokens, cursor, depth);
    output.push(value);
    cursor = nextStructural(tokens, afterValue);
  }
  return [output, requireClose(tokens, cursor, "array")];
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
    if (token?.type !== "text") throw new Error(`Property list ${name} contains nested markup.`);
    value += token.value;
    cursor += 1;
  }

  if (!isCloseToken(tokens[cursor], name)) throw new Error(`Property list ${name} is not closed.`);
  const text = unescapeXml(value.trim());
  if (name === "integer") {
    if (!/^-?\d+$/u.test(text)) throw new Error("Invalid property list integer.");
    const integer = Number(text);
    if (!Number.isSafeInteger(integer)) throw new Error("Property list integer is outside the safe integer range.");
    return [integer, cursor + 1];
  }
  if (name === "real") {
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(text)) throw new Error("Invalid property list real.");
    const real = Number(text);
    if (!Number.isFinite(real)) throw new Error("Property list real must be finite.");
    return [real, cursor + 1];
  }
  if (name === "data") {
    const data = text.replace(/\s+/g, "");
    if (data && (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length % 4 !== 0)) throw new Error("Invalid property list data.");
    return [plistData(data), cursor + 1];
  }
  if (name === "date") {
    if (!strictIsoDate(text)) {
      throw new Error("Invalid property list date.");
    }
  }
  return [text, cursor + 1];
}

function strictIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && day >= 1 && day <= monthDays[month - 1]
    && Number(hourText) <= 23
    && Number(minuteText) <= 59
    && Number(secondText) <= 59;
}

function nextStructural(tokens: PlistToken[], index: number): number {
  let cursor = index;
  while (tokens[cursor]?.type === "text") cursor += 1;
  return cursor;
}

function requireClose(tokens: PlistToken[], index: number, name: string): number {
  const cursor = nextStructural(tokens, index);
  if (!isCloseToken(tokens[cursor], name)) throw new Error(`Property list ${name} is not closed correctly.`);
  return cursor + 1;
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
  const source = String(value ?? "");
  if (/&(?!(?:apos|quot|gt|lt|amp|#\d+|#x[\da-f]+);)/iu.test(source)) throw new Error("Unsupported property list entity.");
  return source
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#(\d+);/gu, (_match, valueText: string) => String.fromCodePoint(Number(valueText)))
    .replace(/&#x([\da-f]+);/giu, (_match, valueText: string) => String.fromCodePoint(Number.parseInt(valueText, 16)))
    .replace(/&amp;/g, "&");
}
