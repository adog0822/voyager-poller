import { AdapterError, type Adapter } from "../types.ts";
import { unitFrom, type Pay } from "../details.ts";
import { toEpochMs } from "../text.ts";

// GET https://api.ashbyhq.com/posting-api/job-board/{board}   (full description included)
// Blocks default library user agents: the polite fetcher always sends VoyagerBot.

export type AshbyJob = {
  id: string;
  title: string;
  jobUrl: string;
  location?: string;
  isRemote?: boolean;
  isListed?: boolean;
  publishedAt?: string;
  descriptionPlain?: string;
  department?: string;
  team?: string;
  compensation?: { summaryComponents?: { compensationType?: string; minValue?: number | null; maxValue?: number | null; currencyCode?: string; interval?: string }[] };
};

export function ashbyPay(j: AshbyJob): Pay | null {
  const c = j.compensation?.summaryComponents?.find((x) => x.compensationType === "Salary" && (x.minValue ?? 0) > 0);
  if (!c?.minValue) return null;
  const unit = unitFrom(c.interval);
  if (!unit) return null;
  return { min: c.minValue, max: Math.max(c.minValue, c.maxValue ?? c.minValue), unit, currency: (c.currencyCode ?? "USD").slice(0, 3), source: "ats" };
}

export const ashby: Adapter<AshbyJob> = {
  ats: "ashby",

  async fetchList(src, ctx) {
    const board = src.config.board ?? src.boardToken;
    const res = await ctx.fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`, {
      signal: ctx.signal,
    });
    if (!res.ok) throw new AdapterError(`ashby ${res.status} ${src.boardToken}`, "ashby", res.status);
    const jobs = ((await res.json()) as { jobs?: AshbyJob[] }).jobs ?? [];
    return jobs.filter((j) => j.isListed !== false);
  },

  normalize(_src, j) {
    return {
      externalId: j.id,
      title: j.title.trim(),
      url: j.jobUrl,
      location: j.location?.trim() || null,
      remote: typeof j.isRemote === "boolean" ? j.isRemote : null,
      sourcePostedAt: toEpochMs(j.publishedAt ?? null),
      descriptionText: j.descriptionPlain?.trim() || null,
      department: [j.department, j.team].filter(Boolean).join(" - ") || null,
      pay: ashbyPay(j),
    };
  },
};
