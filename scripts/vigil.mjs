#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const help = `Vigil

  vigil update phone     Update your iPhone (also: vigil update)
  vigil update mac       Update the Mac through Vigil's protected updater
  vigil status phone     Check the iPhone without updating
  vigil status mac       Check the Mac updater

Run from any folder. Add --verbose to see the full build output.
Phone updates reuse build caches and verify the app, live policy and services.
Apple signing/verification still requires Internet access on the phone.
`;

export function terminalCommand(args) {
  if (!args.length || args.some(value => ["--help", "-h", "help"].includes(value))) return { help: true };
  const [command, ...remaining] = args;
  if (!["update", "status"].includes(command)) throw new Error(`Unknown command: ${command}. Run vigil --help.`);
  const target = remaining[0] && !remaining[0].startsWith("-") ? remaining.shift() : "phone";
  if (!["phone", "mac"].includes(target)) throw new Error(`Unknown target: ${target}. Use phone or mac.`);
  const verbose = remaining.includes("--verbose");
  const options = remaining.filter(value => value !== "--verbose");
  const script = target === "phone"
    ? command === "update" ? "agent:update:social" : "ios:phone:status"
    : command === "update" ? "agent:update" : "agent";
  const forwarded = target === "mac" && command === "status" ? ["update-status", ...options] : options;
  return { command, target, verbose, args: ["run", "--silent", script, ...(forwarded.length ? ["--", ...forwarded] : [])] };
}

export function updateFailureHelp(output) {
  if (/Phone sources changed during the update/i.test(output)) return "Phone source files are still changing. Wait for the edits to finish, then run the same command again.";
  if (/invalid code signature|profile has not been explicitly trusted|Unable to Verify App/i.test(output)) {
    return "iOS has not verified this app. In Settings → General → VPN & Device Management, open your developer and tap Verify App. If it fails, try cellular, then run the same command again.";
  }
  if (/not reachable|No paired physical iPhone|Paired physical iPhone not found/i.test(output)) {
    return "Connect your paired iPhone by USB or make it reachable on the local network, then run the same command again.";
  }
  if (/already running|Another Vigil phone update/i.test(output)) return "Another phone update is running. Let it finish, then retry.";
  if (/non-removable supervised policy.*USB|Connect the paired iPhone over USB/is.test(output)) {
    return "This update changes the protected policy. Connect the iPhone by USB, then run the same command again.";
  }
  return "The update did not complete. The full error is in the log below; retrying reuses verified build tools and Xcode's incremental cache.";
}

async function main(args) {
  const request = terminalCommand(args);
  if (request.help) { process.stdout.write(help); return 0; }
  const directory = join(homedir(), "Library", "Logs", "Vigil", "updates");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const logPath = join(directory, `${request.target}-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}.log`);
  const log = createWriteStream(logPath, { flags: "wx", mode: 0o600 });
  await once(log, "open");
  const started = Date.now();
  const tty = Boolean(process.stdout.isTTY && !request.verbose);
  let stage = null, buffer = "", tail = "", final = false, frame = 0;
  const elapsed = since => `${((Date.now() - since) / 1000).toFixed(1)}s`;
  const clear = () => { if (tty) process.stdout.write("\r\x1b[2K"); };
  const finishStage = () => {
    if (!stage) return;
    clear(); process.stdout.write(`  ✓ ${stage.label}  ${elapsed(stage.started)}\n`); stage = null;
  };
  const line = value => {
    const marker = "@@vigil-update ";
    if (!value.startsWith(marker)) {
      if (request.verbose || request.command === "status" || request.target === "mac") process.stdout.write(value + "\n");
      return;
    }
    let event;
    try { event = JSON.parse(value.slice(marker.length)); } catch { return; }
    finishStage();
    if (["current", "complete"].includes(event.stage)) {
      final = true; process.stdout.write(`\n  ✓ ${event.label}\n`); return;
    }
    stage = { label: event.label, started: Date.now() };
    if (!tty) process.stdout.write(`  … ${event.label}\n`);
    if (event.detail) { clear(); process.stdout.write(`\n  ${event.detail}\n\n`); }
  };
  process.stdout.write(`\nVigil · ${request.command === "update" ? "Update" : "Status"} ${request.target === "phone" ? "iPhone" : "Mac"}\n\n`);
  const timer = tty ? setInterval(() => {
    if (stage) process.stdout.write(`\r\x1b[2K  ${["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][frame++ % 10]} ${stage.label}  ${elapsed(stage.started)}`);
  }, 100) : null;
  const child = spawn("npm", request.args, { cwd: root, env: { ...process.env, VIGIL_TERMINAL_UPDATE: "1" }, stdio: ["inherit", "pipe", "pipe"] });
  const consume = chunk => {
    log.write(chunk); tail = (tail + chunk).slice(-96 * 1024); buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop();
    for (const value of lines) line(value);
  };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", consume); child.stderr.on("data", consume);
  let outcome;
  try {
    outcome = await new Promise((done, fail) => { child.once("error", fail); child.once("exit", (code, signal) => done({ code: code ?? 1, signal })); });
  } finally {
    if (timer) clearInterval(timer);
    clear();
    if (buffer) line(buffer);
    await new Promise(done => log.end(done));
  }
  if (outcome.code !== 0) {
    process.stderr.write(`\n  Update incomplete (${elapsed(started)}).\n  ${updateFailureHelp(tail)}\n  Log: ${logPath}\n\n`);
    return outcome.code;
  }
  finishStage();
  if (request.command === "update" && !final) process.stdout.write("  ✓ Update completed\n");
  process.stdout.write(`\n  Finished in ${elapsed(started)} · Log: ${logPath}\n\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Vigil: ${error.message}\n`); process.exitCode = 1; }
}
