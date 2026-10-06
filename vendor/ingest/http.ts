import { ALLOW_ALL, DISALLOW_ALL, isPathAllowed, parseRobots, type RobotsRules } from "./robots.ts";

export type PoliteFetchInit = RequestInit & {
  /**
   * Extra paths on the same host that must also be allowed by robots.txt.
   * Workday: the career site path (`/{site}/`) a company disallows, even though the
   * JSON API lives under `/wday/cxs/`.
   */
  alsoRequirePaths?: string[];
};
export type PoliteFetch = (url: string, init?: PoliteFetchInit) => Promise<Response>;

export class BlockedUrlError extends Error {
  readonly url: string;
  constructor(url: string, why: string) {
    super(`blocked url (${why}): ${url}`);
    this.name = "BlockedUrlError";
    this.url = url;
  }
}

/**
 * SSRF guard: public http(s) hosts only. Hostnames come from scraped career pages, so
 * loopback, private, link-local (cloud metadata), CGNAT and .internal/.local names are refused.
 */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError(raw, "unparseable");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BlockedUrlError(raw, "scheme");
  if (u.username || u.password) throw new BlockedUrlError(raw, "credentials");
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") && !h.includes(":")) {
    throw new BlockedUrlError(raw, "local hostname");
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) {
      throw new BlockedUrlError(raw, "private address");
    }
  }
  if (h.includes(":") && (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:") || h === "::")) {
    throw new BlockedUrlError(raw, "private address");
  }
  return u;
}

export class ResponseTooLargeError extends Error {
  constructor(url: string, max: number) {
    super(`response over ${max} bytes: ${url}`);
    this.name = "ResponseTooLargeError";
  }
}

export class RobotsDisallowedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = "RobotsDisallowedError";
    this.url = url;
  }
}

export type PoliteFetchOptions = {
  userAgent: string;
  /** Token matched against robots.txt `User-agent:` lines. */
  robotsToken?: string;
  timeoutMs?: number;
  perHostConcurrency?: number;
  /** Minimum gap between request starts to the same host (raised by Crawl-delay). */
  minGapMs?: number;
  maxRetries?: number;
  respectRobots?: boolean;
  fetchImpl?: typeof fetch;
  /** Responses larger than this are refused (parsers run on the whole body). */
  maxBodyBytes?: number;
  /**
   * Rate-limit bucket for a host. Multi-tenant platforms give every company its own
   * hostname but share infrastructure (and rate limits), so they share one bucket.
   */
  hostGroup?: (host: string) => string;
  /** Per-bucket overrides of concurrency / minimum gap (e.g. a roomier Workday bucket). */
  groupLimits?: Record<string, { concurrency: number; gapMs: number }>;
};

// Workday: ~1.2k tenants share one bucket. 6 in flight / 150ms apart avoided 429s in
// production while keeping a full cold run well under the Actions job timeout.
export const DEFAULT_GROUP_LIMITS: Record<string, { concurrency: number; gapMs: number }> = {
  "*.myworkdayjobs.com": { concurrency: 6, gapMs: 150 },
  // Microsoft's careers API rate-limits bursts: one request at a time, 1.5s apart.
  "apply.careers.microsoft.com": { concurrency: 1, gapMs: 1500 },
};

const SHARED_PLATFORMS = [".myworkdayjobs.com", ".myworkdaysite.com", ".oraclecloud.com", ".bamboohr.com", ".icims.com", ".applytojob.com"];

export function defaultHostGroup(host: string): string {
  const shared = SHARED_PLATFORMS.find((suffix) => host.endsWith(suffix));
  return shared ? `*${shared}` : host;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createPoliteFetch(opts: PoliteFetchOptions): PoliteFetch {
  const {
    userAgent,
    robotsToken = "VoyagerBot",
    timeoutMs = 10_000,
    perHostConcurrency = 3,
    minGapMs = 300,
    maxRetries = 2,
    respectRobots = true,
    fetchImpl = fetch,
    hostGroup = defaultHostGroup,
    groupLimits = DEFAULT_GROUP_LIMITS,
    maxBodyBytes = 8 * 1024 * 1024,
  } = opts;

  const robotsCache = new Map<string, Promise<RobotsRules>>();
  type Bucket = { active: number; nextStart: number; waiters: (() => void)[]; gapMs: number; concurrency: number };
  const hosts = new Map<string, Bucket>();

  function hostState(key: string) {
    let h = hosts.get(key);
    if (!h) {
      const limit = groupLimits[key];
      h = { active: 0, nextStart: 0, waiters: [], gapMs: limit?.gapMs ?? minGapMs, concurrency: limit?.concurrency ?? perHostConcurrency };
      hosts.set(key, h);
    }
    return h;
  }

  async function acquire(key: string) {
    const h = hostState(key);
    while (h.active >= h.concurrency) await new Promise<void>((r) => h.waiters.push(r));
    h.active++;
    const wait = h.nextStart - Date.now();
    h.nextStart = Math.max(Date.now(), h.nextStart) + h.gapMs;
    if (wait > 0) await sleep(wait);
  }

  function release(host: string) {
    const h = hostState(host);
    h.active--;
    h.waiters.shift()?.();
  }

  async function rawFetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", userAgent);
    if (!headers.has("Accept")) headers.set("Accept", "application/json, text/xml;q=0.9, */*;q=0.5");
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    // Redirects are followed manually (below) so every hop is SSRF- and robots-checked.
    return fetchImpl(url, { ...init, headers, signal, redirect: "manual" });
  }

  /** Buffer the body with a running byte count; refuse anything over maxBodyBytes. */
  async function capped(res: Response, url: string, max = maxBodyBytes): Promise<Response> {
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > max) {
      await res.body?.cancel();
      throw new ResponseTooLargeError(url, max);
    }
    if (!res.body) return res;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new ResponseTooLargeError(url, max);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      body.set(c, off);
      off += c.byteLength;
    }
    const out = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperty(out, "url", { value: url });
    return out;
  }

  function robotsFor(origin: string): Promise<RobotsRules> {
    let p = robotsCache.get(origin);
    if (!p) {
      p = (async () => {
        try {
          let res = await rawFetch(`${origin}/robots.txt`, { headers: { Accept: "text/plain" } });
          // RFC 9309: follow up to 5 redirects (each target SSRF-checked).
          for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400 && res.headers.get("location"); hop++) {
            const next = assertPublicUrl(new URL(res.headers.get("location")!, `${origin}/robots.txt`).toString());
            await res.body?.cancel();
            res = await rawFetch(next.toString(), { headers: { Accept: "text/plain" } });
          }
          // RFC 9309: 4xx = no restrictions; 5xx/unreachable = assume full disallow.
          if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
          if (!res.ok) return DISALLOW_ALL;
          const type = res.headers.get("content-type") ?? "";
          if (type.includes("html")) return ALLOW_ALL; // soft-404 HTML page, not a robots file
          // Oversized robots.txt → treated as unreachable (full disallow): conservative.
          return parseRobots(await (await capped(res, `${origin}/robots.txt`, 1024 * 1024)).text(), robotsToken);
        } catch {
          return DISALLOW_ALL;
        }
      })();
      robotsCache.set(origin, p);
    }
    return p;
  }

  async function checkRobots(u: URL, extraPaths: string[] = []) {
    if (!respectRobots) return;
    const robots = await robotsFor(u.origin);
    const paths = [u.pathname + u.search, ...extraPaths];
    if (!paths.every((p) => isPathAllowed(robots, p))) throw new RobotsDisallowedError(u.toString());
    if (robots.crawlDelaySec) {
      const h = hostState(hostGroup(u.host));
      h.gapMs = Math.max(h.gapMs, Math.min(robots.crawlDelaySec, 30) * 1000);
    }
  }

  async function fetchOnce(url: string, reqInit: RequestInit): Promise<Response> {
    const u = new URL(url);
    const bucket = hostGroup(u.host);
    for (let attempt = 0; ; attempt++) {
      await acquire(bucket);
      let res: Response;
      try {
        res = await rawFetch(url, reqInit);
      } catch (err) {
        release(bucket);
        if (attempt >= maxRetries || (err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") throw err;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      release(bucket);
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        // 429 without Retry-After: back off harder (3s, 6s, ...) than for 5xx (1s, 2s, ...).
        const base = res.status === 429 ? 3000 : 1000;
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 30_000) : base * 2 ** attempt;
        await res.body?.cancel();
        await sleep(delay);
        continue;
      }
      return res;
    }
  }

  return async function politeFetch(url, init = {}) {
    const { alsoRequirePaths, ...reqInit } = init;
    let current = assertPublicUrl(url);
    await checkRobots(current, alsoRequirePaths);
    for (let hop = 0; hop <= 5; hop++) {
      const res = await fetchOnce(current.toString(), reqInit);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return capped(res, current.toString());
      await res.body?.cancel();
      const next = assertPublicUrl(new URL(location, current).toString());
      if (next.origin !== current.origin) await checkRobots(next);
      // 303 (and 301/302 after POST, per browsers) become GET without a body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && reqInit.method && reqInit.method !== "GET")) {
        reqInit.method = "GET";
        delete reqInit.body;
      }
      current = next;
    }
    throw new BlockedUrlError(url, "too many redirects");
  };
}
