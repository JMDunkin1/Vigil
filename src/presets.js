export const DISTRACTION_PRESETS = [
  {
    id: "social",
    label: "Social",
    apps: ["Discord"],
    sites: ["reddit.com", "x.com", "instagram.com", "tiktok.com", "facebook.com", "threads.net", "snapchat.com", "pinterest.com"]
  },
  {
    id: "video",
    label: "Video",
    apps: ["TV", "Music", "Podcasts"],
    sites: ["youtube.com", "netflix.com", "twitch.tv", "hulu.com", "disneyplus.com"]
  },
  {
    id: "games",
    label: "Games",
    apps: ["Steam", "Epic Games Launcher", "Battle.net", "Roblox", "Minecraft"],
    sites: ["steamcommunity.com", "steampowered.com", "roblox.com", "itch.io"]
  },
  {
    id: "news",
    label: "News",
    apps: ["News", "Podcasts"],
    sites: ["news.google.com", "news.ycombinator.com", "cnn.com", "nytimes.com", "washingtonpost.com"]
  },
  {
    id: "shopping",
    label: "Shopping",
    apps: [],
    sites: ["amazon.com", "ebay.com", "etsy.com", "aliexpress.com"]
  },
  {
    id: "rehab",
    label: "Rehab",
    apps: ["Discord", "Steam", "Epic Games Launcher", "Battle.net", "Music", "TV", "Podcasts", "News", "Photos"],
    sites: ["youtube.com", "reddit.com", "x.com", "instagram.com", "tiktok.com", "facebook.com", "netflix.com", "twitch.tv", "threads.net", "snapchat.com", "pinterest.com"]
  }
];

export function distractionPresets() {
  return DISTRACTION_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    apps: [...preset.apps],
    sites: [...preset.sites]
  }));
}
