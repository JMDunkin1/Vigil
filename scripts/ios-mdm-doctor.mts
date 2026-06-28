import { iosMdmDoctor } from "../src/iosMdm.js";
import { loadState } from "../src/store.js";

const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const state = await loadState();
const doctor = iosMdmDoctor(state);

if (json) {
  console.log(JSON.stringify(doctor, null, 2));
} else {
  console.log(formatDoctor(doctor));
}

if (strict && !doctor.ready) process.exitCode = 1;

function formatDoctor(doctor: ReturnType<typeof iosMdmDoctor>): string {
  const lines = [
    "Vigil Advanced Self-hosted iOS MDM Doctor",
    "Normal free delivery path: ManageEngine (`npm run ios:manageengine:export`).",
    `Status: ${doctor.status}`,
    `Capability: ${doctor.capabilityLevel}`,
    `Static USB profile: ${doctor.staticProfile.status || "unknown"}${doctor.staticProfile.active ? " (active)" : ""}`,
    `Self-hosted MDM enabled: ${doctor.remoteMdm.enabled ? "yes" : "no"}`,
    `Self-hosted public base URL: ${doctor.remoteMdm.publicBaseUrl || "missing"}`,
    `APNs topic: ${doctor.remoteMdm.topic || "missing"}`,
    `Enrollment URL: ${doctor.remoteMdm.enrollmentUrl || "not available until setup blockers are fixed"}`,
    `Enrolled devices: ${doctor.remoteMdm.enrolledDeviceCount}`,
    ""
  ];

  if (doctor.blockers.length) {
    lines.push("Blocking setup items:");
    for (const item of doctor.blockers) lines.push(`- ${item.message} ${item.env?.length ? `(${item.env.join(", ")})` : ""}`);
    lines.push("");
  }

  if (doctor.warnings.length) {
    lines.push("Warnings:");
    for (const item of doctor.warnings) lines.push(`- ${item.message}`);
    lines.push("");
  }

  lines.push("Next steps:");
  for (const step of doctor.nextSteps) lines.push(`- ${step}`);
  lines.push("");
  lines.push("External prerequisites:");
  for (const prerequisite of doctor.externalPrerequisites) lines.push(`- ${prerequisite}`);
  return lines.join("\n");
}
