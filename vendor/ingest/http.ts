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
    return fetchImpl(url, { ...init, headers, signal, redirect: "follow" });
  }

  function robotsFor(origin: string): Promise<RobotsRules> {
    let p = robotsCache.get(origin);
    if (!p) {
      p = (async () => {
        try {
          const res = await rawFetch(`${origin}/robots.txt`, { headers: { Accept: "text/plain" } });
          // RFC 9309: 4xx = no restrictions; 5xx/unreachable = assume full disallow.
          if (res.status >= 400 && res.status < 500) return ALLOW_ALL;
          if (!res.ok) return DISALLOW_ALL;
          const type = res.headers.get("content-type") ?? "";
          if (type.includes("html")) return ALLOW_ALL; // soft-404 HTML page, not a robots file
          return parseRobots(await res.text(), robotsToken);
        } catch {
          return DISALLOW_ALL;
        }
      })();
      robotsCache.set(origin, p);
    }
    return p;
  }

  return async function politeFetch(url, init = {}) {
    const { alsoRequirePaths, ...reqInit } = init;
    const u = new URL(url);
    if (respectRobots) {
      const robots = await robotsFor(u.origin);
      const paths = [u.pathname + u.search, ...(alsoRequirePaths ?? [])];
      if (!paths.every((p) => isPathAllowed(robots, p))) throw new RobotsDisallowedError(url);
      if (robots.crawlDelaySec) {
        const h = hostState(hostGroup(u.host));
        h.gapMs = Math.max(h.gapMs, robots.crawlDelaySec * 1000);
      }
    }

    const bucket = hostGroup(u.host);
    for (let attempt = 0; ; attempt++) {
      await acquire(bucket);
      let res: Response;
      try {
        res = await rawFetch(url, reqInit);
      } catch (err) {
        release(bucket);
        if (attempt >= maxRetries || (err as Error).name === "AbortError") throw err;
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
  };
}
