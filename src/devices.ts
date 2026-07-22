import { basename, join } from "node:path";
import { grayscaleSummary } from "./grayscale.js";
import { iosMdmSummary } from "./iosMdm.js";
import { iosProfileSummary } from "./iosProfiles.js";
import {
  MANAGEENGINE_POLICY_PROFILE_PATH,
  pinManageEngineCurrentGeneration
} from "./manageEngineExport.js";
import type { VigilState } from "./types.js";

export interface DeviceSummaryOptions {
  manageEngineOutputDirectory?: string;
}

export async function deviceSummary(state: VigilState, options: DeviceSummaryOptions = {}) {
  const ios = iosProfileSummary(state);
  const currentGeneration = await verifiedManageEngineGeneration(
    ios.manageEngine,
    options.manageEngineOutputDirectory
  );
  return {
    grayscale: grayscaleSummary(state),
    ios: {
      ...ios,
      manageEngine: {
        ...ios.manageEngine,
        currentGeneration
      },
      mdm: iosMdmSummary(state)
    }
  };
}

async function verifiedManageEngineGeneration(
  evidence: ReturnType<typeof iosProfileSummary>["manageEngine"],
  outputDirectory: string | undefined
): Promise<boolean> {
  if (!evidence.currentGeneration || !outputDirectory || !evidence.generation || !evidence.profileHash) return false;
  let pin: Awaited<ReturnType<typeof pinManageEngineCurrentGeneration>> | null = null;
  try {
    pin = await pinManageEngineCurrentGeneration(outputDirectory);
    const profileArtifact = pin.paths[join("main", basename(MANAGEENGINE_POLICY_PROFILE_PATH))];
    const verified = pin.manifest.generation === evidence.generation
      && basename(pin.generationPath) === evidence.generation
      && profileArtifact?.sha256 === evidence.profileHash;
    await pin.assertValid();
    await pin.release();
    pin = null;
    return verified;
  } catch {
    return false;
  } finally {
    if (pin) await pin.release().catch(() => {});
  }
}
