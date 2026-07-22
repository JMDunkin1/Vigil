#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../src/directRun.js";

const project = "ios/VigilSocial/VigilSocial.xcodeproj";
const valueOptions = new Set(["service", "configuration", "destination", "derived-data", "version", "build", "unclassified-media-policy"]);
const unclassifiedMediaPolicies = new Set(["conceal", "reveal-unclassified"]);
const services = {
  instagram: {
    bundleId: "tech.caseline.vigil.instagram",
    name: "Instagram",
    icon: "instagram.png",
    scheme: "vigil-instagram"
  },
  youtube: {
    bundleId: "tech.caseline.vigil.youtube",
    name: "YouTube",
    icon: "youtube.png",
    scheme: "vigil-youtube"
  }
} as const;

interface BuildOptions {
  service: string;
  configuration: string;
  destination: string;
  derivedData: string;
  unsigned: boolean;
  version: string;
  build: string;
  unclassifiedMediaPolicy: string;
}

export function buildArguments(argv: string[]): string[] {
  const options = parseOptions(argv);
  if (!isService(options.service)) throw new Error(`Unknown social service: ${options.service || "(missing)"}`);
  const service = services[options.service];

  const args = [
    "-project", project,
    "-scheme", "VigilSocial",
    "-configuration", options.configuration,
    "-destination", options.destination,
    "build",
    `PRODUCT_BUNDLE_IDENTIFIER=${service.bundleId}`,
    `VIGIL_SERVICE=${options.service}`,
    `SOCIAL_APP_NAME=${service.name}`,
    `SOCIAL_ICON_NAME=${service.icon}`,
    `SOCIAL_URL_SCHEME=${service.scheme}`,
    `VIGIL_UNCLASSIFIED_MEDIA_POLICY=${options.unclassifiedMediaPolicy}`,
    `MARKETING_VERSION=${options.version}`,
    `CURRENT_PROJECT_VERSION=${options.build}`
  ];
  if (options.derivedData) args.splice(8, 0, "-derivedDataPath", options.derivedData);
  if (options.unsigned) args.push("CODE_SIGNING_ALLOWED=NO");
  return args;
}

export function parseOptions(argv: string[]): BuildOptions {
  const release = phoneRelease();
  const values = new Map<string, string>();
  let service = "";
  let unsigned = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--unsigned") {
      unsigned = true;
    } else if (argument.startsWith("--")) {
      const name = argument.slice(2);
      if (!valueOptions.has(name)) throw new Error(`Unknown option: --${name}`);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
      values.set(name, value);
      index += 1;
    } else if (!service) {
      service = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  const unclassifiedMediaPolicy = values.get("unclassified-media-policy") || "conceal";
  if (!unclassifiedMediaPolicies.has(unclassifiedMediaPolicy)) {
    throw new Error(`Unknown unclassified media policy: ${unclassifiedMediaPolicy}`);
  }
  return {
    service: values.get("service") || service,
    configuration: values.get("configuration") || "Release",
    destination: values.get("destination") || "generic/platform=iOS",
    derivedData: values.get("derived-data") || "",
    unsigned,
    version: values.get("version") || release.version,
    build: values.get("build") || String(release.build),
    unclassifiedMediaPolicy
  };
}

function phoneRelease(): { version: string; build: number } {
  const fallback = { version: "0.1.0", build: 1 };
  const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidates = [
    resolve("ios/phone-release.json"),
    join(moduleRoot, "ios", "phone-release.json"),
    join(moduleRoot, "..", "..", "ios", "phone-release.json")
  ];
  for (const path of candidates) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as Partial<typeof fallback>;
      if (/^\d+\.\d+\.\d+$/.test(String(value.version || "")) && Number.isInteger(value.build) && Number(value.build) > 0) {
        return { version: String(value.version), build: Number(value.build) };
      }
    } catch {
      // Try the next repository/runtime layout.
    }
  }
  return fallback;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write("Usage: npm run ios:social:build -- <instagram|youtube> [--configuration Debug|Release] [--destination value] [--derived-data path] [--version x.y.z] [--build number] [--unclassified-media-policy conceal|reveal-unclassified] [--unsigned]\n");
    return;
  }
  await run("xcodebuild", buildArguments(argv));
}

function isService(value: string): value is keyof typeof services {
  return Object.hasOwn(services, value);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal) rejectRun(new Error(`${command} ended after ${signal}`));
      else if (code) rejectRun(new Error(`${command} exited with code ${code}`));
      else resolveRun();
    });
  });
}

if (isDirectRun(import.meta.url)) await main();
