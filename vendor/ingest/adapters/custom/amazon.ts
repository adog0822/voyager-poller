import { AdapterError, type Adapter } from "../../types.ts";
import { htmlToText, toEpochMs } from "../../text.ts";

// amazon.jobs public search JSON (what the site itself calls). robots.txt disallows only /internal.
//   GET https://www.amazon.jobs/en/search.json?base_query={term}&result_limit=100&offset=N&sort=recent

export type AmazonJob = {
  id_icims: string;
  title: string;
  job_path: string;
  posted_date?: string; // "October  2, 2026"
  normalized_location?: string;
  location?: string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
};

const LIMIT = 100;
const MAX_PAGES = 3;
const TERMS = ["co-op", "intern"];

export const amazon: Adapter<AmazonJob> = {
  ats: "custom",
  async fetchList(_src, ctx) {
    const seen = new Map<string, AmazonJob>();
    for (const term of TERMS) {
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(term)}&result_limit=${LIMIT}&offset=${page * LIMIT}&sort=recent`;
        const res = await ctx.fetch(url, { signal: ctx.signal });
        if (!res.ok) throw new AdapterError(`amazon ${res.status}`, "custom", res.status);
        const body = (await res.json()) as { hits?: number; jobs?: AmazonJob[] };
        const jobs = body.jobs ?? [];
        for (const j of jobs) seen.set(j.id_icims, j);
        if (jobs.length < LIMIT || (page + 1) * LIMIT >= (body.hits ?? 0)) break;
      }
    }
    return [...seen.values()];
  },
  normalize(_src, j) {
    const location = j.normalized_location || j.location || null;
    const desc = [j.description, j.basic_qualifications, j.preferred_qualifications].map((h) => htmlToText(h)).filter(Boolean).join("\n\n");
    return {
      externalId: j.id_icims,
      title: j.title.trim(),
      url: `https://www.amazon.jobs${j.job_path}`,
      location,
      remote: location ? /virtual|remote/i.test(location) : null,
      sourcePostedAt: toEpochMs(j.posted_date?.replace(/\s+/g, " ") ?? null),
      descriptionText: desc || null,
    };
  },
};
