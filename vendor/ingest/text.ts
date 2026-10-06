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

/** Remove <script>/<style> blocks with indexOf scanning (regex spans are quadratic on unclosed tags). */
export function stripBlocks(html: string, tags = ["script", "style"]): string {
  let s = html;
  for (const tag of tags) {
    let out = "";
    let i = 0;
    const lower = s.toLowerCase();
    for (;;) {
      const open = lower.indexOf(`<${tag}`, i);
      if (open < 0) break;
      const close = lower.indexOf(`</${tag}>`, open);
      out += s.slice(i, open) + " ";
      if (close < 0) {
        i = s.length;
        break;
      }
      i = close + tag.length + 3;
    }
    s = out + s.slice(i);
  }
  return s;
}

/** HTML (possibly entity-escaped, as Greenhouse returns it) → readable plain text. Linear-time. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  let s = html.includes("&lt;") ? decodeEntities(html) : html;
  // [^<>]* (not [^>]+) keeps every pattern linear on hostile input like "<<<<…".
  s = stripBlocks(s)
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^<>]*>/gi, "• ")
    .replace(/<[^<>]*>/g, " ");
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
  // Bounded spans: unclosed <a> tags on a hostile page can't make this quadratic.
  for (const m of html.matchAll(/<a\b[^<>]{0,2000}?\bhref\s*=\s*"([^"<>]{1,2048})"[^<>]{0,2000}>([\s\S]{0,4000}?)<\/a>/gi)) {
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
  // indexOf scan over <script type="application/ld+json"> blocks (no unbounded regex spans).
  const lower = html.toLowerCase();
  let from = 0;
  for (let n = 0; n < 50; n++) {
    const tagStart = lower.indexOf("<script", from);
    if (tagStart < 0) break;
    const tagEnd = lower.indexOf(">", tagStart);
    const close = tagEnd < 0 ? -1 : lower.indexOf("</script>", tagEnd);
    if (tagEnd < 0 || close < 0) break;
    from = close + 9;
    if (!/type\s*=\s*["']application\/ld\+json["']/.test(lower.slice(tagStart, tagEnd))) continue;
    let data: unknown;
    try {
      data = JSON.parse(html.slice(tagEnd + 1, close).trim());
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
