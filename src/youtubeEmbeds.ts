// Browser-owned frame URLs establish provenance; page referrers and messages
// cannot turn a YouTube recommendation into an external video.
type EmbedFrame = { frameId: number; parentFrameId: number; url: string; documentId?: string };
type EmbedSender = { tab?: { id?: number }; frameId?: number; url?: string; documentId?: string };
type EmbedRecord = { top: string; frames: Record<string, string | null> };
interface EmbedAPI {
  storage: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  frames(tabId: number): Promise<EmbedFrame[] | null>;
}
export function youtubeEmbedID(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
        || !/^(www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(url.hostname)
        || url.searchParams.has('list') || url.searchParams.has('playlist')) return null;
    return /^\/embed\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}
export function createYouTubeEmbedPolicy(api: EmbedAPI) {
  const queues = new Map<number, Promise<unknown>>();
  function serial<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const next = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(operation);
    void queues.set(tabId, next);
    const cleanup = () => { if (queues.get(tabId) === next) queues.delete(tabId); };
    void next.then(cleanup, cleanup);
    return next;
  }
  const key = (tabId: number) => `youtube-embeds:${tabId}`;
  async function inspect(sender: EmbedSender, register: boolean): Promise<string | null> {
    const tabId = sender.tab?.id, frameId = sender.frameId;
    if (tabId === undefined || frameId === undefined || frameId <= 0) return null;
    return serial(tabId, async () => {
      const frames = await api.frames(tabId);
      const frame = frames?.find(item => item.frameId === frameId);
      const top = frames?.find(item => item.frameId === 0);
      if (!frame || !top || frame.url !== sender.url
          || (sender.documentId && frame.documentId && sender.documentId !== frame.documentId)) return null;
      const topIdentity = top.documentId || top.url;
      const stored = (await api.storage.get(key(tabId)))[key(tabId)] as EmbedRecord | undefined;
      const record: EmbedRecord = stored?.top === topIdentity ? stored : { top: topIdentity, frames: {} };
      const id = youtubeEmbedID(frame.url);
      let parent = frame, external = true;
      const seen = new Set<number>([frameId]);
      while (parent.frameId !== 0) {
        const ancestor = frames!.find(item => item.frameId === parent.parentFrameId);
        if (!ancestor || seen.has(ancestor.frameId)) { external = false; break; }
        seen.add(ancestor.frameId);
        const url = new URL(ancestor.url);
        if (!/^https?:$/.test(url.protocol) || /(^|\.)(youtube(?:-nocookie)?\.com|youtu\.be)$/.test(url.hostname)) {
          external = false; break;
        }
        parent = ancestor;
      }
      // Pin the first document in each frame until the containing page reloads.
      // A recommendation navigating that frame must not mint another exemption.
      if (register && !Object.hasOwn(record.frames, String(frameId))) {
        record.frames[frameId] = external ? id : null;
        await api.storage.set({ [key(tabId)]: record });
      }
      return external && id && record.frames[frameId] === id ? id : null;
    });
  }
  return {
    register: (sender: EmbedSender) => inspect(sender, true),
    eligible: async (sender: EmbedSender, videoId: unknown) => Boolean(videoId && await inspect(sender, false) === videoId),
    reset: (tabId: number) => serial(tabId, () => api.storage.set({ [key(tabId)]: null }))
  };
}
