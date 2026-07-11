#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const sourceRoots = ["app", "extension", "public", "scripts", "src", "tests"];
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".ts", ".mts"]);
const identifierPattern = String.raw`[A-Za-z_$][\w$]*`;
const reservedIdentifiers = new Set([
  "async",
  "await",
  "catch",
  "class",
  "const",
  "constructor",
  "export",
  "for",
  "function",
  "if",
  "import",
  "let",
  "new",
  "return",
  "throw",
  "try",
  "var",
  "void",
  "while"
]);

async function listFiles(root, extensions) {
  const rootPath = path.join(projectRoot, root);
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.relative(projectRoot, fullPath), extensions));
      continue;
    }
    if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

function relativePath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isUsableIdentifier(value) {
  return Boolean(value && !reservedIdentifiers.has(value));
}

function findMatchingParen(source, openParenIndex) {
  let depth = 0;
  for (let currentIndex = openParenIndex; currentIndex < source.length; currentIndex += 1) {
    const char = source[currentIndex];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return currentIndex;
    }
  }
  return -1;
}

function isSignatureLike(source, openParenIndex) {
  const closeParenIndex = findMatchingParen(source, openParenIndex);
  if (closeParenIndex < 0) return false;
  const after = source.slice(closeParenIndex + 1).trimStart();
  return after.startsWith(":") || after.startsWith("=>") || after.startsWith("{");
}

function stripCommentAndStringContent(source) {
  let stripped = "";
  let index = 0;

  const appendBlanked = (value) => {
    stripped += value === "\n" ? "\n" : " ";
  };
  const previousNonWhitespace = (startIndex) => {
    for (let currentIndex = startIndex; currentIndex >= 0; currentIndex -= 1) {
      if (!/\s/u.test(source[currentIndex])) return source[currentIndex];
    }
    return undefined;
  };
  const isLikelyRegexStart = (previous) => previous === undefined || "([{=,:;!&|?+-*~^<>".includes(previous);

  const stripQuotedString = (quote) => {
    appendBlanked(source[index]);
    index += 1;
    while (index < source.length) {
      const stringChar = source[index];
      appendBlanked(stringChar);
      index += 1;
      if (stringChar === "\\") {
        if (index < source.length) {
          appendBlanked(source[index]);
          index += 1;
        }
        continue;
      }
      if (stringChar === quote) break;
    }
  };

  const stripTemplateLiteral = () => {
    appendBlanked(source[index]);
    index += 1;
    while (index < source.length) {
      const templateChar = source[index];
      const templateNext = source[index + 1];

      if (templateChar === "\\") {
        appendBlanked(templateChar);
        index += 1;
        if (index < source.length) {
          appendBlanked(source[index]);
          index += 1;
        }
        continue;
      }

      if (templateChar === "`") {
        appendBlanked(templateChar);
        index += 1;
        break;
      }

      if (templateChar === "$" && templateNext === "{") {
        appendBlanked(templateChar);
        appendBlanked(templateNext);
        index += 2;
        stripCode(1);
        continue;
      }

      appendBlanked(templateChar);
      index += 1;
    }
  };

  const stripCode = (templateExpressionDepth = 0) => {
    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];

      if (templateExpressionDepth > 0 && char === "}") {
        appendBlanked(char);
        index += 1;
        return;
      }

      if (templateExpressionDepth > 0 && char === "{") {
        stripped += char;
        index += 1;
        stripCode(templateExpressionDepth + 1);
        continue;
      }

      if (char === "/" && next === "/") {
        appendBlanked(char);
        appendBlanked(next);
        index += 2;
        while (index < source.length && source[index] !== "\n") {
          appendBlanked(source[index]);
          index += 1;
        }
        continue;
      }

      if (char === "/" && next === "*") {
        appendBlanked(char);
        appendBlanked(next);
        index += 2;
        while (index < source.length) {
          const blockChar = source[index];
          const blockNext = source[index + 1];
          appendBlanked(blockChar);
          index += 1;
          if (blockChar === "*" && blockNext === "/") {
            appendBlanked(blockNext);
            index += 1;
            break;
          }
        }
        continue;
      }

      if (char === "/" && isLikelyRegexStart(previousNonWhitespace(index - 1))) {
        let inCharacterClass = false;
        appendBlanked(char);
        index += 1;
        while (index < source.length) {
          const regexChar = source[index];
          appendBlanked(regexChar);
          index += 1;
          if (regexChar === "\\") {
            if (index < source.length) {
              appendBlanked(source[index]);
              index += 1;
            }
            continue;
          }
          if (regexChar === "[") {
            inCharacterClass = true;
            continue;
          }
          if (regexChar === "]") {
            inCharacterClass = false;
            continue;
          }
          if (regexChar === "/" && !inCharacterClass) break;
        }
        while (index < source.length && /[A-Za-z]/u.test(source[index])) {
          appendBlanked(source[index]);
          index += 1;
        }
        continue;
      }

      if (char === "\"" || char === "'") {
        stripQuotedString(char);
        continue;
      }

      if (char === "`") {
        stripTemplateLiteral();
        continue;
      }

      stripped += char;
      index += 1;
    }
  };

  stripCode();
  return stripped;
}

function statementAround(source, index) {
  const start = source.lastIndexOf(";", index) + 1;
  const nextSemicolon = source.indexOf(";", index);
  const end = nextSemicolon >= 0 ? nextSemicolon + 1 : source.length;
  return { start, text: source.slice(start, end) };
}

function isPromiseExpressionHandled(statement, expressionIndex) {
  const before = statement.slice(0, expressionIndex);
  return /\b(await|return|void|throw)\b/u.test(before) || /[A-Za-z_$][\w$.[\]]*\s*=\s*/u.test(before);
}

function previousNonEmptyLines(source, index, limit = 8) {
  const before = source.slice(0, index).split("\n");
  const lines = [];
  for (let cursor = before.length - 1; cursor >= 0 && lines.length < limit; cursor -= 1) {
    const line = before[cursor]?.trim();
    if (line) lines.push(line);
  }
  return lines;
}

function promiseContinuationIsHandled(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  if (source.slice(lineStart, index).trim()) return false;
  return previousNonEmptyLines(source, index).some((line) => (
    /\b(await|return|void|throw)\b/u.test(line) || /[A-Za-z_$][\w$.[\]]*\s*=/u.test(line)
  ));
}

function collectPromiseSymbols(stripped) {
  const functionNames = new Set();
  const memberNames = new Set();
  const exportedNames = new Set();

  const addFunction = (name, exported = false) => {
    if (!isUsableIdentifier(name)) return;
    functionNames.add(name);
    if (exported) exportedNames.add(name);
  };
  const addMember = (name) => {
    if (isUsableIdentifier(name)) memberNames.add(name);
  };

  for (const match of stripped.matchAll(new RegExp(String.raw`\bexport\s+async\s+function\s+(${identifierPattern})\s*\(`, "gu"))) {
    addFunction(match[1], true);
  }
  for (const match of stripped.matchAll(new RegExp(String.raw`\basync\s+function\s+(${identifierPattern})\s*\(`, "gu"))) {
    addFunction(match[1]);
  }
  for (const match of stripped.matchAll(new RegExp(String.raw`\bexport\s+function\s+(${identifierPattern})(?:\s*<[^>\n]+>)?\s*\([^)]*\)\s*:\s*Promise\s*(?:<|\b)`, "gu"))) {
    addFunction(match[1], true);
  }
  for (const match of stripped.matchAll(new RegExp(String.raw`\bfunction\s+(${identifierPattern})(?:\s*<[^>\n]+>)?\s*\([^)]*\)\s*:\s*Promise\s*(?:<|\b)`, "gu"))) {
    addFunction(match[1]);
  }
  for (const match of stripped.matchAll(new RegExp(String.raw`\bexport\s+(?:const|let|var)\s+(${identifierPattern})\s*(?::[^=;\n]+)?=\s*async\b`, "gu"))) {
    addFunction(match[1], true);
  }
  for (const match of stripped.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${identifierPattern})\s*(?::[^=;\n]+)?=\s*async\b`, "gu"))) {
    addFunction(match[1]);
  }
  for (const match of stripped.matchAll(new RegExp(String.raw`(?:^|[;{\n])\s*async\s+(${identifierPattern})\s*\(`, "gu"))) {
    addMember(match[1]);
  }
  for (const match of stripped.matchAll(new RegExp(String.raw`(?:^|[;{\n])\s*(${identifierPattern})\s*(?:<[^>\n]+>)?\s*\([^;{}]*\)\s*:\s*Promise\s*(?:<|\b)`, "gu"))) {
    addFunction(match[1]);
    addMember(match[1]);
  }
  for (const match of stripped.matchAll(new RegExp(String.raw`(?:^|[;{,\n])\s*(${identifierPattern})\s*:\s*(?:<[^>\n]+>\s*)?\([^)]*\)\s*=>\s*Promise\s*(?:<|\b)`, "gu"))) {
    addFunction(match[1]);
    addMember(match[1]);
  }
  for (const match of stripped.matchAll(/\bexport\s*\{\s*([^}]+)\s*\}/gu)) {
    const specifiers = match[1].split(",");
    for (const specifier of specifiers) {
      const [localName, exportedName = localName] = specifier.trim().split(/\s+as\s+/u);
      if (functionNames.has(localName)) exportedNames.add(exportedName);
    }
  }

  return { functionNames, memberNames, exportedNames };
}

function resolveImportFile(filePath, specifier, filePathSet) {
  if (!specifier.startsWith(".")) return null;
  const importedPath = path.resolve(path.dirname(filePath), specifier);
  const extension = path.extname(importedPath);
  const candidates = [];

  if (extension) {
    candidates.push(importedPath);
    if (extension === ".js") candidates.push(importedPath.slice(0, -3) + ".ts");
    if (extension === ".mjs") candidates.push(importedPath.slice(0, -4) + ".mts");
  } else {
    for (const sourceExtension of sourceExtensions) {
      candidates.push(`${importedPath}${sourceExtension}`);
    }
    for (const sourceExtension of sourceExtensions) {
      candidates.push(path.join(importedPath, `index${sourceExtension}`));
    }
  }

  return candidates.find((candidate) => filePathSet.has(candidate)) || null;
}

function importedPromiseFunctionNames(filePath, source, exportedPromiseNamesByFile, filePathSet) {
  const names = new Set();
  const importPattern = /\bimport\s+(?!type\b)\{([^}]+)\}\s+from\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(importPattern)) {
    const importedFile = resolveImportFile(filePath, match[2], filePathSet);
    if (!importedFile) continue;
    const exportedNames = exportedPromiseNamesByFile.get(importedFile);
    if (!exportedNames) continue;

    for (const specifier of match[1].split(",")) {
      const [importedName, localName = importedName] = specifier.trim().split(/\s+as\s+/u);
      if (exportedNames.has(importedName)) names.add(localName);
    }
  }
  return names;
}

function promiseSymbolsForRecord(record, exportedPromiseNamesByFile, filePathSet) {
  const functionNames = new Set(record.promiseSymbols.functionNames);
  const memberNames = new Set(record.promiseSymbols.memberNames);
  for (const name of importedPromiseFunctionNames(record.filePath, record.source, exportedPromiseNamesByFile, filePathSet)) {
    functionNames.add(name);
  }
  return { functionNames, memberNames };
}

function checkNoExplicitAny(filePath, source, stripped, errors) {
  const matches = [...stripped.matchAll(/(?<![A-Za-z0-9_$.])any(?![A-Za-z0-9_$])/gu)];
  for (const match of matches) {
    errors.push(`${relativePath(filePath)}:${lineNumber(source, match.index || 0)} uses explicit any.`);
  }
}

function checkNoTsNocheck(filePath, source, errors) {
  const index = source.slice(0, 250).indexOf("@ts-nocheck");
  if (index >= 0) errors.push(`${relativePath(filePath)}:${lineNumber(source, index)} uses @ts-nocheck.`);
}

function checkFloatingPromiseChains(filePath, source, stripped, errors) {
  const promisePattern = /\.then\s*\(|\.catch\s*\(|\bnew\s+Promise\s*\(|\bPromise\.(?:resolve|reject)\s*\(/gu;
  for (const match of stripped.matchAll(promisePattern)) {
    const index = match.index || 0;
    if (promiseContinuationIsHandled(stripped, index)) continue;
    const statement = statementAround(stripped, index);
    if (isPromiseExpressionHandled(statement.text, index - statement.start)) continue;
    errors.push(`${relativePath(filePath)}:${lineNumber(source, index)} has a promise chain without await, return, assignment, or void.`);
  }
}

function checkFloatingPromiseCalls(filePath, source, stripped, promiseSymbols, errors) {
  const functionNames = [...promiseSymbols.functionNames].sort();
  if (functionNames.length) {
    const functionPattern = new RegExp(String.raw`(^|[;{}\n])\s*(${functionNames.map(escapeRegExp).join("|")})\s*(?:<[^>\n]+>)?\(`, "gu");
    for (const match of stripped.matchAll(functionPattern)) {
      const index = (match.index || 0) + match[0].indexOf(match[2]);
      const openParenIndex = (match.index || 0) + match[0].lastIndexOf("(");
      if (isSignatureLike(stripped, openParenIndex)) continue;
      const statement = statementAround(stripped, index);
      if (isPromiseExpressionHandled(statement.text, index - statement.start)) continue;
      errors.push(`${relativePath(filePath)}:${lineNumber(source, index)} calls promise-returning function ${match[2]} without await, return, assignment, or void.`);
    }
  }

  const memberNames = [...promiseSymbols.memberNames].sort();
  if (memberNames.length) {
    const memberPattern = new RegExp(String.raw`(^|[;{}\n])\s*(?:this|${identifierPattern})(?:\s*(?:\.|\?\.)\s*${identifierPattern})*\s*(?:\.|\?\.)\s*(${memberNames.map(escapeRegExp).join("|")})\s*(?:<[^>\n]+>)?\(`, "gu");
    for (const match of stripped.matchAll(memberPattern)) {
      const index = (match.index || 0) + match[0].lastIndexOf(match[2]);
      const openParenIndex = (match.index || 0) + match[0].lastIndexOf("(");
      if (isSignatureLike(stripped, openParenIndex)) continue;
      const statement = statementAround(stripped, index);
      if (isPromiseExpressionHandled(statement.text, index - statement.start)) continue;
      errors.push(`${relativePath(filePath)}:${lineNumber(source, index)} calls promise-returning method ${match[2]} without await, return, assignment, or void.`);
    }
  }
}

function isObviouslyNonErrorExpression(expression) {
  return /^(["'`]|\d|true\b|false\b|null\b|undefined\b|\{|\[)/u.test(expression.trimStart());
}

function checkPromiseRejectionErrors(filePath, source, stripped, errors) {
  const rejectPattern = /\bPromise\.reject\s*\(/gu;
  for (const match of stripped.matchAll(rejectPattern)) {
    const openParenIndex = (match.index || 0) + match[0].lastIndexOf("(");
    const expression = source.slice(openParenIndex + 1);
    if (!isObviouslyNonErrorExpression(expression)) continue;
    errors.push(`${relativePath(filePath)}:${lineNumber(source, match.index || 0)} rejects a non-Error value.`);
  }

  const throwPattern = /\bthrow\b/gu;
  for (const match of stripped.matchAll(throwPattern)) {
    const expression = source.slice((match.index || 0) + match[0].length);
    if (!isObviouslyNonErrorExpression(expression)) continue;
    errors.push(`${relativePath(filePath)}:${lineNumber(source, match.index || 0)} throws a non-Error value.`);
  }
}

function checkUnsafeDomWrites(filePath, source, stripped, errors) {
  if (!relativePath(filePath).startsWith("public/")) return;
  const pattern = /\.(?:innerHTML|outerHTML)\s*=|\.insertAdjacentHTML\s*\(|\bdocument\.write\s*\(/gu;
  for (const match of stripped.matchAll(pattern)) {
    errors.push(`${relativePath(filePath)}:${lineNumber(source, match.index || 0)} uses an unsafe HTML injection API.`);
  }
}

function assertScanner() {
  const forbiddenType = "a" + "ny";
  const stripped = stripCommentAndStringContent(`const text = \`plain ${forbiddenType}\`; const value = \`\${foo as ${forbiddenType}}\`;`);
  if ((stripped.match(/(?<![A-Za-z0-9_$.])any(?![A-Za-z0-9_$])/gu) || []).length !== 1) {
    throw new Error("Source lint scanner self-check failed.");
  }

  const floatingSource = "async function save() {}\nsave();\nvoid save();\nawait save();\n";
  const floatingErrors = [];
  checkFloatingPromiseCalls(
    path.join(projectRoot, "scripts", "lint-source-self-check.mjs"),
    floatingSource,
    stripCommentAndStringContent(floatingSource),
    collectPromiseSymbols(stripCommentAndStringContent(floatingSource)),
    floatingErrors
  );
  if (floatingErrors.length !== 1) {
    throw new Error("Source lint floating-promise self-check failed.");
  }

  const storePath = path.join(projectRoot, "src", "store.ts");
  const importerPath = path.join(projectRoot, "scripts", "lint-source-self-check.mts");
  const exportSymbols = collectPromiseSymbols(stripCommentAndStringContent("export async function persistState() {}\n"));
  const importerSource = "import { persistState as save } from \"../src/store.js\";\nsave();\n";
  const importerRecord = {
    filePath: importerPath,
    source: importerSource,
    promiseSymbols: collectPromiseSymbols(stripCommentAndStringContent(importerSource))
  };
  const importErrors = [];
  checkFloatingPromiseCalls(
    importerPath,
    importerSource,
    stripCommentAndStringContent(importerSource),
    promiseSymbolsForRecord(
      importerRecord,
      new Map([[storePath, exportSymbols.exportedNames]]),
      new Set([storePath, importerPath])
    ),
    importErrors
  );
  if (importErrors.length !== 1) {
    throw new Error("Source lint imported-promise self-check failed.");
  }

  const rejectionErrors = [];
  const rejectionSource = "Promise.reject('bad');\nthrow 'bad';\nthrow new Error('ok');\n";
  checkPromiseRejectionErrors(
    path.join(projectRoot, "scripts", "lint-source-self-check.mjs"),
    rejectionSource,
    stripCommentAndStringContent(rejectionSource),
    rejectionErrors
  );
  if (rejectionErrors.length !== 2) {
    throw new Error("Source lint Error-rejection self-check failed.");
  }

  const unsafeDomErrors = [];
  const unsafeDomSource = "node.innerHTML = value;\nnode.textContent = value;\n";
  checkUnsafeDomWrites(
    path.join(projectRoot, "public", "lint-source-self-check.ts"),
    unsafeDomSource,
    stripCommentAndStringContent(unsafeDomSource),
    unsafeDomErrors
  );
  if (unsafeDomErrors.length !== 1) {
    throw new Error("Source lint unsafe-DOM self-check failed.");
  }
}

const errors = [];
assertScanner();

const files = (await Promise.all(sourceRoots.map((root) => listFiles(root, sourceExtensions))))
  .flat()
  .sort((left, right) => relativePath(left).localeCompare(relativePath(right)));
const records = await Promise.all(files.map(async (filePath) => {
  const source = await fs.readFile(filePath, "utf8");
  const stripped = stripCommentAndStringContent(source);
  return {
    filePath,
    source,
    stripped,
    promiseSymbols: collectPromiseSymbols(stripped)
  };
}));
const filePathSet = new Set(records.map((record) => record.filePath));
const exportedPromiseNamesByFile = new Map(records.map((record) => [record.filePath, record.promiseSymbols.exportedNames]));

for (const record of records) {
  const { filePath, source, stripped } = record;
  checkNoExplicitAny(filePath, source, stripped, errors);
  checkNoTsNocheck(filePath, source, errors);
  checkFloatingPromiseChains(filePath, source, stripped, errors);
  checkFloatingPromiseCalls(filePath, source, stripped, promiseSymbolsForRecord(record, exportedPromiseNamesByFile, filePathSet), errors);
  checkPromiseRejectionErrors(filePath, source, stripped, errors);
  checkUnsafeDomWrites(filePath, source, stripped, errors);
}

if (errors.length) {
  throw new Error(`Source lint failed:\n${errors.map((entry) => `- ${entry}`).join("\n")}`);
}

console.log(`Source lint passed: ${files.length} source files checked.`);
