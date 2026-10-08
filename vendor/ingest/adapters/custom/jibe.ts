import { AdapterError, type Adapter } from "../../types.ts";
import { htmlToText, toEpochMs } from "../../text.ts";

// Jibe career sites (iCIMS's candidate front-end) on the company's own domain or
// {company}.jibeapply.com. The site itself serves its listings as JSON:
//   GET {origin}/api/jobs?keywords={term}&page={n}&limit=100
// We read only the company's front-end (its robots.txt allows it); the iCIMS portals behind
// many of these disallow crawling and are never fetched.

export type JibeJob = {
  slug?: string;
  req_id?: string;
  title?: string;
  description?: string;
  full_location?: string;
  location_name?: string;
  posted_date?: string;
  category?: string[];
  categories?: { name?: string }[];
};

const TERMS = ["co-op", "intern"];
const PAGE = 100;
const MAX_PAGES = 5;

const originOf = (careersUrl: string | null | undefined, boardToken: string) => new URL(careersUrl ?? `https://${boardToken.replace(/^jibe:/, "")}`).origin;

export const jibe: Adapter<JibeJob> = {
  ats: "custom",
  async fetchList(src, ctx) {
    const origin = originOf(src.careersUrl, src.boardToken);
    const seen = new Map<string, JibeJob>();
    for (const term of TERMS) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${origin}/api/jobs?keywords=${encodeURIComponent(term)}&page=${page}&limit=${PAGE}`;
        const res = await ctx.fetch(url, { signal: ctx.signal, headers: { Accept: "application/json" } });
        if (!res.ok || !res.headers.get("content-type")?.includes("json")) throw new AdapterError(`jibe ${res.status} ${origin}`, "custom", res.status);
        const body = (await res.json()) as { jobs?: { data?: JibeJob }[]; totalCount?: number };
        const jobs = (body.jobs ?? []).map((j) => j.data).filter((j): j is JibeJob => !!j?.title && !!(j.slug ?? j.req_id));
        for (const j of jobs) seen.set(String(j.slug ?? j.req_id), j);
        if (jobs.length < PAGE || page * PAGE >= (body.totalCount ?? 0)) break;
      }
    }
    return [...seen.values()];
  },
  normalize(src, j) {
    const origin = originOf(src.careersUrl, src.boardToken);
    const id = String(j.slug ?? j.req_id);
    const location = j.full_location?.trim() || j.location_name?.trim() || null;
    return {
      externalId: id,
      title: j.title!.trim(),
      url: `${origin}/jobs/${encodeURIComponent(id)}`,
      location,
      remote: location ? /remote/i.test(location) : null,
      sourcePostedAt: toEpochMs(j.posted_date ?? null),
      descriptionText: htmlToText(j.description)?.slice(0, 20_000) ?? null,
      department: j.categories?.[0]?.name?.trim() || j.category?.[0]?.trim() || null,
    };
  },
};
