import { AdapterError, type Adapter } from "../types.ts";
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
};

export const ashby: Adapter<AshbyJob> = {
  ats: "ashby",

  async fetchList(src, ctx) {
    const board = src.config.board ?? src.boardToken;
    const res = await ctx.fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`, {
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
    };
  },
};
