import { compileLiquidGlassIcon } from "./compile-liquid-glass-icon.mjs";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  await compileLiquidGlassIcon(context.appOutDir + "/Vigil.app");
}
