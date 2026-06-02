import { iosMdmSummary } from "./iosMdm.js";
import { iosProfileSummary } from "./iosProfiles.js";
import type { SentinelState } from "./types.js";

export async function deviceSummary(state: SentinelState) {
  return {
    ios: {
      ...iosProfileSummary(state),
      mdm: iosMdmSummary(state)
    }
  };
}
