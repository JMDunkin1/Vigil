export type MinecraftAudioTrackId = `minecraft-${string}`;

export interface MinecraftAudioTrack {
  id: MinecraftAudioTrackId;
  title: string;
  composer: string;
  resourcePath: string;
  src: string;
  sourcePage: string;
  license: string;
  licenseUrl: string;
  attribution: string;
}

const sourcePage = "https://c418.org/album-category/minecraft/";
const usageGuidelines = "https://www.minecraft.net/en-us/usage-guidelines";
const classicTracks = [
  ["minecraft", "Minecraft", "minecraft/sounds/music/game/minecraft.ogg"],
  ["sweden", "Sweden", "minecraft/sounds/music/game/sweden.ogg"],
  ["mice-on-venus", "Mice on Venus", "minecraft/sounds/music/game/mice_on_venus.ogg"],
  ["wet-hands", "Wet Hands", "minecraft/sounds/music/game/wet_hands.ogg"],
  ["dry-hands", "Dry Hands", "minecraft/sounds/music/game/dry_hands.ogg"],
  ["subwoofer-lullaby", "Subwoofer Lullaby", "minecraft/sounds/music/game/subwoofer_lullaby.ogg"],
  ["haggstrom", "Haggstrom", "minecraft/sounds/music/game/haggstrom.ogg"],
  ["living-mice", "Living Mice", "minecraft/sounds/music/game/living_mice.ogg"]
] as const;

export const minecraftAudioCatalog: readonly MinecraftAudioTrack[] = classicTracks.map(([slug, title, resourcePath]) => ({
  id: `minecraft-${slug}`,
  title,
  composer: "C418",
  resourcePath,
  src: `/audio/minecraft/${slug}.ogg`,
  sourcePage,
  license: "Minecraft usage rules",
  licenseUrl: usageGuidelines,
  attribution: `${title} by C418, played from your local Minecraft Java Edition installation. The recording is not bundled with Vigil.`
}));
