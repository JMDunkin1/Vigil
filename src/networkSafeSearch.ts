import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";

export interface SafeSearchHostMapping {
  id: "google" | "bing" | "duckduckgo";
  label: string;
  target: string;
  hosts: readonly string[];
  addresses: readonly string[];
}

interface SafeSearchEndpoint {
  id: SafeSearchHostMapping["id"];
  label: string;
  target: string;
  hosts: readonly string[];
  fallbackAddresses: readonly string[];
}

interface SafeSearchResolver {
  resolve4: (hostname: string) => Promise<readonly string[]>;
  resolve6: (hostname: string) => Promise<readonly string[]>;
}

// Google publishes this list for administrators mapping Search to the
// forcesafesearch.google.com VIP. Keep the apex, www, and image-search hosts
// together so a browser cannot select a regional or image endpoint omitted
// from the machine-wide rule.
const GOOGLE_SUPPORTED_DOMAINS = `
google.com google.ad google.ae google.com.af google.com.ag google.al google.am
google.co.ao google.com.ar google.as google.at google.com.au google.az google.ba
google.com.bd google.be google.bf google.bg google.com.bh google.bi google.bj
google.com.bn google.com.bo google.com.br google.bs google.bt google.co.bw
google.by google.com.bz google.ca google.cd google.cf google.cg google.ch google.ci
google.co.ck google.cl google.cm google.cn google.com.co google.co.cr google.com.cu
google.cv google.com.cy google.cz google.de google.dj google.dk google.dm
google.com.do google.dz google.com.ec google.ee google.com.eg google.es google.com.et
google.fi google.com.fj google.fm google.fr google.ga google.ge google.gg google.com.gh
google.com.gi google.gl google.gm google.gr google.com.gt google.gy google.com.hk
google.hn google.hr google.ht google.hu google.co.id google.ie google.co.il google.im
google.co.in google.iq google.is google.it google.je google.com.jm google.jo
google.co.jp google.co.ke google.com.kh google.ki google.kg google.co.kr google.com.kw
google.kz google.la google.com.lb google.li google.lk google.co.ls google.lt google.lu
google.lv google.com.ly google.co.ma google.md google.me google.mg google.mk google.ml
google.com.mm google.mn google.com.mt google.mu google.mv google.mw google.com.mx
google.com.my google.co.mz google.com.na google.com.ng google.com.ni google.ne google.nl
google.no google.com.np google.nr google.nu google.co.nz google.com.om google.com.pa
google.com.pe google.com.pg google.com.ph google.com.pk google.pl google.pn google.com.pr
google.ps google.pt google.com.py google.com.qa google.ro google.ru google.rw
google.com.sa google.com.sb google.sc google.se google.com.sg google.sh google.si
google.sk google.com.sl google.sn google.so google.sm google.sr google.st google.com.sv
google.td google.tg google.co.th google.com.tj google.tl google.tm google.tn google.to
google.com.tr google.tt google.com.tw google.co.tz google.com.ua google.co.ug
google.co.uk google.com.uy google.co.uz google.com.vc google.co.ve google.co.vi
google.com.vn google.vu google.ws google.rs google.co.za google.co.zm google.co.zw
google.cat
`.trim().split(/\s+/u);

export const SAFE_SEARCH_ENDPOINTS: readonly SafeSearchEndpoint[] = Object.freeze([
  {
    id: "google",
    label: "Google Filter",
    target: "forcesafesearch.google.com",
    hosts: Object.freeze(GOOGLE_SUPPORTED_DOMAINS.flatMap((domain) => [
      domain,
      `www.${domain}`,
      `images.${domain}`
    ])),
    // Google documents these SafeSearch VIP addresses for per-device hosts
    // mappings. Keep them pinned so DNS answer rotation cannot create false
    // hardening drift after a successful apply.
    fallbackAddresses: ["216.239.38.120", "2001:4860:4802:32::78"]
  },
  {
    id: "bing",
    label: "Bing Strict",
    target: "strict.bing.com",
    hosts: ["bing.com", "www.bing.com", "edgeservices.bing.com"],
    fallbackAddresses: [
      "204.79.197.220",
      "2620:1ec:33::16",
      "2620:1ec:33:1::16",
      "2620:1ec:33:2::16",
      "2620:1ec:33:3::16"
    ]
  },
  {
    id: "duckduckgo",
    label: "DuckDuckGo Strict",
    target: "safe.duckduckgo.com",
    hosts: ["duckduckgo.com", "www.duckduckgo.com"],
    fallbackAddresses: ["52.149.247.1"]
  }
]);

const DEFAULT_RESOLVER: SafeSearchResolver = { resolve4, resolve6 };
const CACHE_MS = 5 * 60 * 1000;
let cachedMappings: { expiresAt: number; value: Promise<readonly SafeSearchHostMapping[]> } | null = null;

export function fallbackSafeSearchHostMappings(): readonly SafeSearchHostMapping[] {
  return SAFE_SEARCH_ENDPOINTS.map((endpoint) => ({
    ...endpoint,
    addresses: endpoint.fallbackAddresses
  }));
}

export async function resolveSafeSearchHostMappings(
  resolver: SafeSearchResolver = DEFAULT_RESOLVER,
  options: { fresh?: boolean; now?: () => number } = {}
): Promise<readonly SafeSearchHostMapping[]> {
  const now = options.now || Date.now;
  if (resolver === DEFAULT_RESOLVER && !options.fresh && cachedMappings && cachedMappings.expiresAt > now()) {
    return await cachedMappings.value;
  }

  const value = Promise.all(SAFE_SEARCH_ENDPOINTS.map(async (endpoint) => {
    const settled = await Promise.allSettled([
      resolver.resolve4(endpoint.target),
      resolver.resolve6(endpoint.target)
    ]);
    const resolved = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    const addresses = [...new Set(resolved.map((address) => String(address).trim()).filter((address) => isIP(address) !== 0))]
      .sort((left, right) => isIP(left) - isIP(right) || left.localeCompare(right));
    if (!addresses.length) {
      if (resolver === DEFAULT_RESOLVER) {
        return {
          id: endpoint.id,
          label: endpoint.label,
          target: endpoint.target,
          hosts: endpoint.hosts,
          addresses: endpoint.fallbackAddresses
        } satisfies SafeSearchHostMapping;
      }
      throw new Error(`Could not resolve Vigil's ${endpoint.label} endpoint (${endpoint.target}).`);
    }
    return {
      id: endpoint.id,
      label: endpoint.label,
      target: endpoint.target,
      hosts: endpoint.hosts,
      // Hosts files need stable literal addresses rather than CNAMEs. These
      // provider-specific strict endpoint addresses are connectivity-checked
      // above, while the pinned values keep status attestation deterministic.
      addresses: endpoint.fallbackAddresses
    } satisfies SafeSearchHostMapping;
  }));

  if (resolver === DEFAULT_RESOLVER) cachedMappings = { expiresAt: now() + CACHE_MS, value };
  try {
    return await value;
  } catch (error) {
    if (resolver === DEFAULT_RESOLVER && cachedMappings?.value === value) cachedMappings = null;
    throw error;
  }
}

export function safeSearchHostsLines(
  mappings: readonly SafeSearchHostMapping[],
  blockedHosts: ReadonlySet<string> = new Set()
): string[] {
  const lines: string[] = [];
  for (const mapping of mappings) {
    lines.push(`# ${mapping.label} via ${mapping.target}`);
    for (const host of mapping.hosts) {
      if (blockedHosts.has(host)) continue;
      for (const address of mapping.addresses) lines.push(`${address} ${host}`);
    }
  }
  return lines;
}

export function safeSearchMappedHostCount(mappings: readonly SafeSearchHostMapping[]): number {
  return new Set(mappings.flatMap((mapping) => [...mapping.hosts])).size;
}
