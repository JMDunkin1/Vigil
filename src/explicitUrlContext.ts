import { normalizeAutomaticExplicitText, normalizeExplicitVocabulary, EXPLICIT_SEARCH_KEYWORD_TERMS, containsMultilingualExplicitText } from "./explicitMediaContext.js";

export interface SemanticExplicitUrlMatch {
  component: "hostname" | "path";
  term: string;
  normalizedText: string;
}

/** Shared by the native policy and the generated browser guards. */
export function matchSemanticExplicitUrl(value: unknown): SemanticExplicitUrlMatch | null {
  let url: URL;
  try { url = value instanceof URL ? value : new URL(String(value || "")); }
  catch { return null; }
  if (!/^https?:$/u.test(url.protocol)) return null;

  const strong = new Set([
    ...EXPLICIT_SEARCH_KEYWORD_TERMS,
    "porn", "porno", "pornography", "pornographic", "p0rn", "p0rno", "p0rnography", "hentai", "h3ntai", "nhentai", "nsfw",
    "rule34", "sexcam", "sexcams", "camsex", "sextape", "sextapes",
    "futanari", "erotica", "pornhub", "xvideos", "xnxx", "redgifs"
  ]);
  const media = new Set([
    "video", "videos", "vid", "vids", "photo", "photos", "pic", "pics", "image", "images",
    "gif", "gifs", "cam", "cams", "comic", "comics", "manga", "manhwa", "manhua",
    "webtoon", "webtoons", "doujin", "doujinshi", "novel", "novels", "art", "gallery", "galleries"
  ]);
  const weak = new Set(["adult", "adults", "mature", "uncensored", "lewd", "erotic", "nude", "nudes", "naked", "sex", "sexual", "xxx", "r18", "18plus"]);
  const comics = new Set(["comic", "comics", "manga", "manhwa", "manhua", "webtoon", "webtoons", "doujin", "doujinshi"]);
  const catalog = new Set(["genre", "genres", "category", "categories", "tag", "tags", "catalog", "browse"]);

  function decode(text: string): string {
    let output = text;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const next = decodeURIComponent(output);
        if (next === output) break;
        output = next;
      } catch {
        // An unrelated malformed escape must not hide valid encoded words.
        const next = output.replace(/(?:%[0-9a-f]{2})+/giu, run => {
          try { return decodeURIComponent(run); }
          catch { return run.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))); }
        });
        if (next === output) break;
        output = next;
      }
    }
    return output;
  }

  // Browser URL objects expose IDNs as punycode. Decode one bounded DNS label
  // before evaluating words; never scan the arbitrary xn-- payload as prose.
  function unicodeLabel(label: string): string {
    if (!label.startsWith("xn--")) return label;
    const input = label.slice(4);
    if (input.length > 63) return label;
    const delimiter = input.lastIndexOf("-");
    const output = delimiter < 0 ? [] : [...input.slice(0, delimiter)].map(c => c.codePointAt(0)!);
    let position = delimiter < 0 ? 0 : delimiter + 1;
    let n = 128;
    let index = 0;
    let bias = 72;
    while (position < input.length && output.length < 128) {
      const previous = index;
      let weight = 1;
      for (let k = 36; ; k += 36) {
        if (position >= input.length) return label;
        const code = input.charCodeAt(position++);
        const digit = code >= 48 && code <= 57 ? code - 22
          : code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 97 : 36;
        if (digit >= 36 || index + digit * weight > Number.MAX_SAFE_INTEGER) return label;
        index += digit * weight;
        const threshold = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
        if (digit < threshold) break;
        weight *= 36 - threshold;
        if (!Number.isSafeInteger(weight)) return label;
      }
      const count = output.length + 1;
      let delta = Math.floor((index - previous) / (previous === 0 ? 700 : 2));
      delta += Math.floor(delta / count);
      let k = 0;
      while (delta > 455) { delta = Math.floor(delta / 35); k += 36; }
      bias = k + Math.floor(36 * delta / (delta + 38));
      n += Math.floor(index / count);
      index %= count;
      if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return label;
      output.splice(index++, 0, n);
    }
    try { return String.fromCodePoint(...output); } catch { return label; }
  }

  function normalize(text: string): string {
    // Fold known lookalike vocabulary without partially transliterating real
    // Cyrillic words before the multilingual matcher can recognize them.
    return normalizeExplicitVocabulary(decode(text)).toLowerCase();
  }

  function words(text: string): string[] {
    // Long undelimited identifiers are metadata, not natural-language slugs.
    if (/^[a-z\d_-]{24,}$/iu.test(text) && !/[-_]/u.test(text) && /\d/u.test(text)) return [];
    if (/^[a-f\d]{16,}$/iu.test(text) || /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(text)) return [];
    return normalizeAutomaticExplicitText(normalize(text)).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  }

  function classify(text: string, previousRoute = "", hostname = false): string {
    if (containsMultilingualExplicitText(normalizeAutomaticExplicitText(normalize(text)))) return "explicit-media";
    const tokens = words(/^(?:chapter|book|section|volume|part|appendix)$/u.test(previousRoute) ? `${previousRoute} ${text}` : text);
    if (!tokens.length) return "";
    const explicit = tokens.find(token => strong.has(token));
    if (explicit) return explicit;
    const compact = tokens.join("");
    if (/^(?!rule34\d)(?:p[o0]rn|h[e3]ntai|nsfw|rule34)(?:hub|tube|world|land|zone|site|sites|read|reader|live|free|hd|vr|4k|\d{1,3}|videos?|photos?|pics?|gifs?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?)?$/u.test(compact)) return compact;
    if (/^(?:free|best|my|the|all|hd|new|daily|live|watch|read|anime|manga|comic|comics|webtoon|3d|vr|4k)(?:porn|hentai|nsfw)$/u.test(compact)) return compact;
    // X runs only mean explicit content as a deliberate domain label or with
    // media/catalog context. Embedded axxxb IDs and Chapter XXX are untouched.
    if (hostname && /^x{3,}$/u.test(compact)) return "xxx";
    const mediaAlternatives = "(?:videos?|vids?|photos?|pics?|images?|gifs?|cams?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|novels?|art|galler(?:y|ies))";
    const markerAlternatives = "(?:adults?|mature|uncensored|lewd|erotic|nudes?|naked|sex(?:ual)?|x{3,}|r18|18plus)";
    const compound = new RegExp(`^(?:${markerAlternatives}${mediaAlternatives}|${mediaAlternatives}${markerAlternatives})$`, "u");
    const compoundToken = tokens.find(token => compound.test(token));
    if (compoundToken) return compoundToken;
    // R34 also names an ordinary Nissan chassis. Only comic/catalog context
    // supplies an explicit meaning; car photos and videos remain ordinary.
    if (tokens.some(token => /^r34(?:comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?)$/u.test(token))
      || (tokens.includes("r34") && (tokens.some(token => comics.has(token)) || catalog.has(previousRoute)))) return "r34";
    // A Roman chapter label remains ordinary even when its next route is a
    // gallery. An unrelated medical/research word cannot excuse nude media.
    if (/^(?:chapter|book|section|volume|part|appendix)$/u.test(previousRoute) && /^x{3,}$/u.test(text)) return "";
    const marker = tokens.find((token, index) => (weak.has(token) || /^x{3,}$/u.test(token))
      && !(token === "uncensored" && tokens[index + 1] === "interview"))
      || (/(?:^|[^\p{L}\p{N}])18\+(?=$|[^\p{L}\p{N}])/u.test(text) ? "18plus" : "");
    return marker && (tokens.some(token => media.has(token)) || catalog.has(previousRoute)) ? marker : "";
  }

  const labels = url.hostname.toLowerCase().replace(/\.$/u, "").split(".");
  if (["xxx", "porn"].includes(labels.at(-1) || "")) {
    return { component: "hostname", term: labels.at(-1)!, normalizedText: url.hostname };
  }
  const hostLabels = labels.slice(0, -1).map(label => normalize(unicodeLabel(label)));
  for (const [index, normalizedText] of hostLabels.entries()) {
    const term = classify(normalizedText, "", true);
    if (term) return { component: "hostname", term, normalizedText };
    if (weak.has(normalizedText) && media.has(hostLabels[index + 1] || "")) {
      return { component: "hostname", term: normalizedText, normalizedText: `${normalizedText}.${hostLabels[index + 1]}` };
    }
  }

  // Query values, fragments, credentials, ports and deep path identifiers are
  // deliberately excluded. Existing explicit search/custom rules handle them.
  const segments = url.pathname.split(/\/+/u, 6).filter(Boolean).slice(0, 4);
  // Directory separators can delimit the same established ordinary phrase as
  // hyphens. Qualify only that phrase and retain any separate explicit words.
  const routeText = segments.map(segment => normalizeAutomaticExplicitText(normalize(segment.slice(0, 512)))).join(" ");
  const qualifiedRouteText = normalizeAutomaticExplicitText(routeText);
  if (qualifiedRouteText !== routeText) {
    const catalogRoute = segments.map(segment => normalize(segment)).find(segment => catalog.has(segment)) || "";
    const term = classify(qualifiedRouteText, catalogRoute);
    return term ? { component: "path", term, normalizedText: qualifiedRouteText } : null;
  }
  for (let i = 0; i < segments.length; i += 1) {
    const normalizedText = normalize(segments[i].slice(0, 512));
    const previousRoute = i ? normalize(segments[i - 1]) : "";
    const term = classify(normalizedText, previousRoute);
    if (term) return { component: "path", term, normalizedText };
    const romanChapter = /^x{3,}$/u.test(normalizedText) && /^(?:chapter|book|section|volume|part|appendix)$/u.test(previousRoute);
    if (!romanChapter && (weak.has(normalizedText) || /^x{3,}$/u.test(normalizedText) || /^18\+$/u.test(normalizedText)
      || (normalizedText === "r34" && comics.has(normalize(segments[i + 1] || ""))))
      && i + 1 < segments.length && words(segments[i + 1]).some(token => media.has(token))) {
      return { component: "path", term: normalizedText, normalizedText };
    }
  }
  return null;
}
