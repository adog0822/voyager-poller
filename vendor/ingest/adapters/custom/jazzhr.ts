import { AdapterError, type Adapter } from "../../types.ts";
import { extractAnchors, htmlToText, jsonLdJobPosting, toEpochMs } from "../../text.ts";

// JazzHR boards: https://{company}.applytojob.com/apply lists every job (server-rendered);
// job pages carry JSON-LD JobPosting. robots.txt disallows only /cb.

export type JazzJob = { id: string; title: string; url: string; location: string | null };

export function parseJazzList(html: string, baseUrl: string): JazzJob[] {
  const out = new Map<string, JazzJob>();
  for (const item of html.matchAll(/<li class="list-group-item">([\s\S]{0,6000}?)<\/li>\s*(?=<li class="list-group-item">|<\/ul>)/gi)) {
    // Anchored to the board's own host: an href like "javascript:…//applytojob.com/apply/x/" is rejected.
    const host = new URL(baseUrl).host.replace(/\./g, "\\.");
    const [a] = extractAnchors(item[1], new RegExp(`^https://${host}/apply/[A-Za-z0-9]+/`), baseUrl);
    if (!a) continue;
    const id = a.href.match(/\/apply\/([A-Za-z0-9]+)\//)?.[1];
    const loc = item[1].match(/fa-map-marker[^>]*><\/i>([^<]*)/i);
    if (!id || !a.text) continue;
    out.set(id, { id, title: a.text, url: a.href, location: loc ? (htmlToText(loc[1]) ?? null) : null });
  }
  return [...out.values()];
}

export const jazzhr: Adapter<JazzJob> = {
  ats: "custom",
  async fetchList(src, ctx) {
    const base = src.careersUrl ?? `https://${src.boardToken.replace(/^jazzhr:/, "")}.applytojob.com/apply`;
    const res = await ctx.fetch(base, { signal: ctx.signal, headers: { Accept: "text/html" } });
    if (!res.ok) throw new AdapterError(`jazzhr ${res.status} ${base}`, "custom", res.status);
    return parseJazzList(await res.text(), base);
  },
  normalize(_src, j) {
    return { externalId: j.id, title: j.title, url: j.url, location: j.location, remote: j.location ? /remote/i.test(j.location) : null, sourcePostedAt: null, descriptionText: null };
  },
  async fetchDetail(_src, posting, ctx) {
    const res = await ctx.fetch(posting.url, { signal: ctx.signal, headers: { Accept: "text/html" } });
    if (!res.ok) throw new AdapterError(`jazzhr detail ${res.status}`, "custom", res.status);
    const ld = jsonLdJobPosting(await res.text());
    return { descriptionText: ld?.description ?? null, sourcePostedAt: toEpochMs(ld?.datePosted ?? null) };
  },
};
