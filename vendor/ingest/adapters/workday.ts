import { AdapterError, type Adapter, type FetchContext, type SourceConfig } from "../types.ts";
import { prefilter } from "../coop.ts";
import { htmlToText, toEpochMs } from "../text.ts";

// Unofficial but public career-site JSON (the same calls the Workday careers page makes).
//   POST https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
//   GET  https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath}
// `limit` > 20 returns HTTP 400.

export type WorkdayJob = {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
};

const PAGE = 20;
const MAX_PAGES = 10; // per search term: 200 student-ish roles is plenty for one board
const SEARCH_TERMS = ["co-op", "intern"];
const DAY = 86_400_000;

/** "Posted Today" | "Posted Yesterday" | "Posted 3 Days Ago" | "Posted 30+ Days Ago" → epoch ms (start of that day, UTC). */
export function parsePostedOn(text: string | undefined, now: number): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const startOfDay = (ms: number) => ms - (ms % DAY);
  if (t.includes("today")) return startOfDay(now);
  if (t.includes("yesterday")) return startOfDay(now - DAY);
  const m = t.match(/(\d+)\+?\s*days?\s*ago/);
  if (m) return startOfDay(now - Number(m[1]) * DAY);
  return null;
}

function base(src: SourceConfig) {
  const { tenant, wd, site } = src.config;
  if (!tenant || !wd || !site) throw new AdapterError(`bad workday config ${src.boardToken}`, "workday");
  return { origin: `https://${tenant}.${wd}.myworkdayjobs.com`, tenant, site };
}

export const workday: Adapter<WorkdayJob> = {
  ats: "workday",

  async fetchList(src: SourceConfig, ctx: FetchContext) {
    const { origin, tenant, site } = base(src);
    const url = `${origin}/wday/cxs/${tenant}/${site}/jobs`;
    const seen = new Map<string, WorkdayJob>();
    for (const searchText of SEARCH_TERMS) {
      // Workday returns `total` on the first page only (later pages say 0), so keep it.
      let total = Infinity;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await ctx.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText }),
          signal: ctx.signal,
          // Respect a company disallowing this career site, even though the API path differs.
          alsoRequirePaths: [`/${site}/`],
        });
        if (!res.ok) throw new AdapterError(`workday ${res.status} ${src.boardToken}`, "workday", res.status);
        const body = (await res.json()) as { total?: number; jobPostings?: WorkdayJob[] };
        const jobs = body.jobPostings ?? [];
        if (page === 0) total = body.total ?? Infinity;
        for (const j of jobs) if (j.externalPath) seen.set(j.externalPath, j);
        if (jobs.length < PAGE || (page + 1) * PAGE >= total) break;
        // Results are relevance-ordered: a page with no student roles means the tail is noise.
        if (!jobs.some((j) => prefilter(j.title))) break;
      }
    }
    return [...seen.values()];
  },

  normalize(src, j, ctx) {
    const { origin, site } = base(src);
    return {
      externalId: j.externalPath,
      title: j.title.trim(),
      url: `${origin}/${site}${j.externalPath}`,
      location: j.locationsText?.trim() || null,
      remote: j.locationsText ? /remote/i.test(j.locationsText) : null,
      sourcePostedAt: parsePostedOn(j.postedOn, (ctx.now ?? Date.now)()),
      descriptionText: null,
    };
  },

  async fetchDetail(src, posting, ctx) {
    const { origin, tenant, site } = base(src);
    const res = await ctx.fetch(`${origin}/wday/cxs/${tenant}/${site}${posting.externalId}`, {
      signal: ctx.signal,
      alsoRequirePaths: [`/${site}/`],
    });
    if (!res.ok) throw new AdapterError(`workday detail ${res.status}`, "workday", res.status);
    const info = ((await res.json()) as { jobPostingInfo?: Record<string, unknown> }).jobPostingInfo ?? {};
    return {
      descriptionText: htmlToText(info.jobDescription as string | undefined),
      // `startDate` is the posting start date (ISO), more precise than "Posted N Days Ago".
      ...(toEpochMs(info.startDate as string | undefined) ? { sourcePostedAt: toEpochMs(info.startDate as string) } : {}),
      ...(typeof info.location === "string" ? { location: info.location } : {}),
    };
  },
};

