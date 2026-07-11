import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PRIVATE_FILE_MODE = 0o600;

interface EvidenceOptions {
  dataDir: string;
  sealPath: string;
  now?: Date;
}

export interface CorruptStateEvidenceResult {
  complete: boolean;
  stateEvidencePath: string;
  sealEvidencePath: string;
  stateEvidenceSaved: boolean;
  sealEvidenceSaved: boolean;
  error?: unknown;
}

export async function preserveCorruptStateEvidence(
  raw: Buffer,
  { dataDir, sealPath, now = new Date() }: EvidenceOptions
): Promise<CorruptStateEvidenceResult> {
  const id = `${now.toISOString().replace(/[:.]/gu, "-")}.${randomUUID()}`;
  const stateEvidencePath = join(dataDir, `state.corrupt.${id}.json`);
  const sealEvidencePath = join(dataDir, `state.corrupt.${id}.seal.json`);
  let stateEvidenceSaved = false;
  let sealEvidenceSaved = false;

  try {
    await writeFile(stateEvidencePath, raw, { flag: "wx", mode: PRIVATE_FILE_MODE });
    stateEvidenceSaved = true;
    await chmod(stateEvidencePath, PRIVATE_FILE_MODE);

    let seal: Buffer;
    try {
      seal = await readFile(sealPath);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return {
          complete: true,
          stateEvidencePath,
          sealEvidencePath,
          stateEvidenceSaved,
          sealEvidenceSaved
        };
      }
      throw error;
    }

    await writeFile(sealEvidencePath, seal, { flag: "wx", mode: PRIVATE_FILE_MODE });
    sealEvidenceSaved = true;
    await chmod(sealEvidencePath, PRIVATE_FILE_MODE);
    return {
      complete: true,
      stateEvidencePath,
      sealEvidencePath,
      stateEvidenceSaved,
      sealEvidenceSaved
    };
  } catch (error) {
    return {
      complete: false,
      stateEvidencePath,
      sealEvidencePath,
      stateEvidenceSaved,
      sealEvidenceSaved,
      error
    };
  }
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
