import { grayscaleSummary } from "./grayscale.js";
import { iosMdmSummary } from "./iosMdm.js";
import { iosProfileSummary } from "./iosProfiles.js";
import type { VigilState } from "./types.js";

export async function deviceSummary(state: VigilState) {
  return {
    grayscale: grayscaleSummary(state),
    ios: {
      ...iosProfileSummary(state),
      mdm: iosMdmSummary(state)
    }
  };
}
