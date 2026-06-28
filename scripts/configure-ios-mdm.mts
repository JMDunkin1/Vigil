import { readFile } from "node:fs/promises";
import { iosMdmDoctor, normalizeIosMdmSettings } from "../src/iosMdm.js";
import { loadState, saveState } from "../src/store.js";
import type { VigilState, UnknownRecord } from "../src/types.js";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const json = Boolean(args.json);
const body: UnknownRecord = {};

copyValue(body, "enabled", args.enable ?? env("VIGIL_MDM_ENABLED"));
copyValue(body, "publicBaseUrl", args["public-base-url"] ?? env("VIGIL_MDM_PUBLIC_BASE_URL"));
copyValue(body, "topic", args.topic ?? env("VIGIL_MDM_TOPIC"));
copyValue(body, "identityCertificateUuid", args["identity-uuid"] ?? env("VIGIL_MDM_IDENTITY_UUID"));
copyValue(body, "identityCertificatePassword", args["identity-password"] ?? env("VIGIL_MDM_IDENTITY_P12_PASSWORD"));
copyValue(body, "pushCertificatePassword", args["push-password"] ?? env("VIGIL_MDM_PUSH_P12_PASSWORD"));
copyValue(body, "useDevelopmentApns", args["development-apns"] ?? env("VIGIL_MDM_DEVELOPMENT_APNS"));

const identityPath = args["identity-p12"] ?? env("VIGIL_MDM_IDENTITY_P12");
const pushPath = args["push-p12"] ?? env("VIGIL_MDM_PUSH_P12");
if (identityPath) body.identityCertificatePayloadBase64 = await fileToBase64(identityPath, "identity PKCS#12");
if (pushPath) body.pushCertificatePayloadBase64 = await fileToBase64(pushPath, "APNs MDM push PKCS#12");

if (Object.keys(body).length === 0) {
  console.error([
    "No MDM settings were provided.",
    "Use --enable plus --public-base-url, --topic, --identity-uuid, --identity-p12, and --push-p12, or set the matching VIGIL_MDM_* env vars.",
    "This helper does not create Apple MDM push certificates or placeholder identities."
  ].join("\n"));
  process.exit(2);
}

const state = await loadState();
state.deviceControls.ios.mdm = normalizeIosMdmSettings(body, state.deviceControls.ios.mdm) as VigilState["deviceControls"]["ios"]["mdm"];
const doctor = iosMdmDoctor(state);

if (!dryRun) await saveState(state);

if (json) {
  console.log(JSON.stringify({ ok: true, dryRun, mdm: doctor }, null, 2));
} else {
  console.log(`${dryRun ? "Dry run" : "Saved"} advanced self-hosted Vigil MDM settings.`);
  console.log(`Status: ${doctor.status}`);
  console.log(`Capability: ${doctor.capabilityLevel}`);
  console.log(`Enrollment URL: ${doctor.remoteMdm.enrollmentUrl || "not available until setup blockers are fixed"}`);
  if (doctor.blockers.length) {
    console.log("\nBlocking setup items:");
    for (const item of doctor.blockers) console.log(`- ${item.message}`);
  }
  console.log("\nManageEngine note: use ManageEngine for the normal free path. This helper only stores real files for an advanced self-hosted APNs server; it does not generate APNs MDM certificates, SCEP service credentials, or working test certs.");
}

function parseArgs(values: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] || "";
    if (!value.startsWith("--")) continue;
    const [name, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) {
      parsed[name] = inline;
    } else if (values[index + 1] && !values[index + 1].startsWith("--")) {
      parsed[name] = values[index + 1];
      index += 1;
    } else {
      parsed[name] = true;
    }
  }
  return parsed;
}

function copyValue(target: UnknownRecord, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  target[key] = value;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

async function fileToBase64(path: string | boolean, label: string): Promise<string> {
  if (typeof path !== "string" || !path) throw new Error(`Missing ${label} path.`);
  try {
    return (await readFile(path)).toString("base64");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${label} at ${path}: ${message}`, { cause: error });
  }
}
