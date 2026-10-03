import { AdapterError, type Adapter } from "../types.ts";
import { toEpochMs } from "../text.ts";

// GET https://api.lever.co/v0/postings/{site}?mode=json   (EU: api.eu.lever.co)
// Full description is in the list response. robots.txt: Crawl-delay 1 (honored by the fetcher).

export type LeverJob = {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  categories?: { location?: string; allLocations?: string[]; commitment?: string };
  workplaceType?: string;
  descriptionPlain?: string;
  additionalPlain?: string;
};

export const lever: Adapter<LeverJob> = {
  ats: "lever",

  async fetchList(src, ctx) {
    const host = src.config.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
    const res = await ctx.fetch(`https://${host}/v0/postings/${src.boardToken}?mode=json`, { signal: ctx.signal });
    if (!res.ok) throw new AdapterError(`lever ${res.status} ${src.boardToken}`, "lever", res.status);
    const body = await res.json();
    if (!Array.isArray(body)) throw new AdapterError(`lever unexpected body ${src.boardToken}`, "lever");
    return body as LeverJob[];
  },

  normalize(_src, j) {
    const loc = j.categories?.location?.trim() || null;
    const desc = [j.descriptionPlain, j.additionalPlain].filter(Boolean).join("\n\n").trim();
    return {
      externalId: j.id,
      title: j.text.trim(),
      url: j.hostedUrl,
      location: loc,
      remote: j.workplaceType ? j.workplaceType === "remote" : loc ? /remote/i.test(loc) : null,
      sourcePostedAt: toEpochMs(j.createdAt ?? null),
      descriptionText: desc || null,
    };
  },
};
