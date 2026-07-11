#!/usr/bin/env node

import { spawn } from "node:child_process";
import { isDirectRun } from "../src/directRun.js";

const project = "ios/VigilSocial/VigilSocial.xcodeproj";
const valueOptions = new Set(["service", "configuration", "destination", "derived-data"]);
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
  },
  snapchat: {
    bundleId: "tech.caseline.vigil.snapchat",
    name: "Snapchat",
    icon: "snapchat.png",
    scheme: "vigil-snapchat"
  }
} as const;

interface BuildOptions {
  service: string;
  configuration: string;
  destination: string;
  derivedData: string;
  unsigned: boolean;
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
    `SOCIAL_URL_SCHEME=${service.scheme}`
  ];
  if (options.derivedData) args.splice(8, 0, "-derivedDataPath", options.derivedData);
  if (options.unsigned) args.push("CODE_SIGNING_ALLOWED=NO");
  return args;
}

export function parseOptions(argv: string[]): BuildOptions {
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
  return {
    service: values.get("service") || service,
    configuration: values.get("configuration") || "Release",
    destination: values.get("destination") || "generic/platform=iOS",
    derivedData: values.get("derived-data") || "",
    unsigned
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write("Usage: npm run ios:social:build -- <instagram|youtube|snapchat> [--configuration Debug|Release] [--destination value] [--derived-data path] [--unsigned]\n");
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
