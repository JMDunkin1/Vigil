import { ensureYouTubeConnection, youtubeConnectionPath } from "../src/youtubeConnection.js";

// Xcode receives only a file path. The credential is copied as a signed native
// resource, never interpolated into build settings or printed in build logs.
export async function youtubeBuildConfiguration(): Promise<string> {
  await ensureYouTubeConnection();
  return youtubeConnectionPath();
}
