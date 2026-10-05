import { AdapterError, type Adapter } from "../../types.ts";
import { extractAnchors, jsonLdJobPosting, toEpochMs } from "../../text.ts";

// iCIMS career portals: server-rendered keyword search; detail pages carry JSON-LD JobPosting.
//   GET https://{host}/jobs/search?ss=1&searchKeyword={term}&in_iframe=1&pr={page}
// robots.txt disallows only referral/login/candidate paths.

export type IcimsJob = { id: string; title: string; url: string };

const TERMS = ["co-op", "intern"];
const MAX_PAGES = 5;
const JOB_HREF = /\/jobs\/\d+\/[^/]+\/job/;

function host(careersUrl: string | null | undefined, boardToken: string) {
  return new URL(careersUrl ?? boardToken).host;
}

export function parseIcimsSearch(html: string, baseUrl: string): IcimsJob[] {
  const jobs = new Map<string, IcimsJob>();
  for (const a of extractAnchors(html, JOB_HREF, baseUrl)) {
    const id = a.href.match(/\/jobs\/(\d+)\//)?.[1];
    const title = a.text.replace(/^Title\s+/i, "").trim();
    if (!id || !title || jobs.has(id)) continue;
    const u = new URL(a.href);
    u.search = ""; // drop in_iframe for the public link
    jobs.set(id, { id, title, url: u.toString() });
  }
  return [...jobs.values()];
}

export const icims: Adapter<IcimsJob> = {
  ats: "custom",
  async fetchList(src, ctx) {
    const h = host(src.careersUrl, src.boardToken);
    const seen = new Map<string, IcimsJob>();
    for (const term of TERMS) {
      for (let pr = 0; pr < MAX_PAGES; pr++) {
        const url = `https://${h}/jobs/search?ss=1&searchKeyword=${encodeURIComponent(term)}&in_iframe=1&pr=${pr}`;
        const res = await ctx.fetch(url, { signal: ctx.signal, headers: { Accept: "text/html" } });
        if (!res.ok) throw new AdapterError(`icims ${res.status} ${h}`, "custom", res.status);
        const jobs = parseIcimsSearch(await res.text(), url);
        const before = seen.size;
        for (const j of jobs) seen.set(j.id, j);
        if (!jobs.length || seen.size === before) break; // no new results: last page
      }
    }
    return [...seen.values()];
  },
  normalize(_src, j) {
    return { externalId: j.id, title: j.title, url: j.url, location: null, remote: null, sourcePostedAt: null, descriptionText: null };
  },
  async fetchDetail(_src, posting, ctx) {
    const res = await ctx.fetch(`${posting.url}?in_iframe=1`, { signal: ctx.signal, headers: { Accept: "text/html" } });
    if (!res.ok) throw new AdapterError(`icims detail ${res.status}`, "custom", res.status);
    const ld = jsonLdJobPosting(await res.text());
    return {
      descriptionText: ld?.description ?? null,
      sourcePostedAt: toEpochMs(ld?.datePosted?.slice(0, 10) ?? null),
      location: ld?.location ?? null,
      ...(ld?.remote ? { remote: true } : {}),
    };
  },
};
