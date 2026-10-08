import { AdapterError, type Adapter } from "../types.ts";
import { unitFrom, type Pay } from "../details.ts";
import { toEpochMs } from "../text.ts";

// GET https://api.lever.co/v0/postings/{site}?mode=json   (EU: api.eu.lever.co)
// Full description is in the list response. robots.txt: Crawl-delay 1 (honored by the fetcher).

export type LeverJob = {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  categories?: { location?: string; allLocations?: string[]; commitment?: string; team?: string; department?: string };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
  workplaceType?: string;
  descriptionPlain?: string;
  additionalPlain?: string;
};

export function leverPay(j: LeverJob): Pay | null {
  const r = j.salaryRange;
  if (!r?.min || r.min <= 0) return null;
  const unit = unitFrom(r.interval);
  if (!unit) return null;
  return { min: r.min, max: Math.max(r.min, r.max ?? r.min), unit, currency: (r.currency ?? "USD").slice(0, 3), source: "ats" };
}

export const lever: Adapter<LeverJob> = {
  ats: "lever",

  async fetchList(src, ctx) {
    const host = src.config.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
    // Lever site names are case-sensitive ("AIFund"); boardToken is lowercased for uniqueness.
    const site = src.config.site ?? src.boardToken;
    const res = await ctx.fetch(`https://${host}/v0/postings/${encodeURIComponent(site)}?mode=json`, { signal: ctx.signal });
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
      department: j.categories?.team || j.categories?.department || null,
      pay: leverPay(j),
    };
  },
};
