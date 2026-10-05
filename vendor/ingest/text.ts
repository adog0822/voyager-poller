// Tiny, dependency-free helpers (no DOMParser in Workers).

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
  bull: "•",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML (possibly entity-escaped, as Greenhouse returns it) → readable plain text. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  let s = html.includes("&lt;") ? decodeEntities(html) : html;
  s = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s || null;
}

export function toEpochMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type Anchor = { href: string; text: string };

/** All <a href> matching `hrefPattern`, with readable link text (nested tags stripped). */
export function extractAnchors(html: string, hrefPattern: RegExp, baseUrl: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = decodeEntities(m[1]);
    if (!hrefPattern.test(raw)) continue;
    let href: string;
    try {
      href = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    out.push({ href, text: (htmlToText(m[2]) ?? "").replace(/\s+/g, " ").trim() });
  }
  return out;
}

export type JsonLdJob = {
  title?: string;
  description?: string;
  datePosted?: string;
  location?: string;
  remote?: boolean;
};

/** schema.org JobPosting from <script type="application/ld+json"> (most career sites ship it for Google Jobs). */
export function jsonLdJobPosting(html: string): JsonLdJob | null {
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const nodes = (Array.isArray(data) ? data : [data, ...(((data as { "@graph"?: unknown[] })?.["@graph"]) ?? [])]) as Record<string, unknown>[];
    const job = nodes.find((n) => n && (n["@type"] === "JobPosting" || (Array.isArray(n["@type"]) && n["@type"].includes("JobPosting"))));
    if (!job) continue;
    const loc = ([] as unknown[]).concat(job.jobLocation ?? [])[0] as { address?: Record<string, string> } | undefined;
    const addr = loc?.address;
    return {
      title: typeof job.title === "string" ? decodeEntities(job.title) : undefined,
      description: htmlToText(typeof job.description === "string" ? job.description : null) ?? undefined,
      datePosted: typeof job.datePosted === "string" ? job.datePosted : undefined,
      location: addr ? [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(", ") || undefined : undefined,
      remote: job.jobLocationType === "TELECOMMUTE" ? true : undefined,
    };
  }
  return null;
}

/** Cookie header from a response's Set-Cookie headers (name=value pairs only). */
export function cookieHeader(res: Response): string {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return all.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}
