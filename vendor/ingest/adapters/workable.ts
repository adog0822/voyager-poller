import { AdapterError, type Adapter } from "../types.ts";
import { htmlToText, toEpochMs } from "../text.ts";

// GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true   (description included)

export type WorkableJob = {
  shortcode: string;
  title: string;
  url: string;
  published_on?: string;
  created_at?: string;
  city?: string;
  state?: string;
  country?: string;
  telecommuting?: boolean;
  description?: string;
};

export const workable: Adapter<WorkableJob> = {
  ats: "workable",

  async fetchList(src, ctx) {
    const slug = src.config.slug ?? src.boardToken;
    const res = await ctx.fetch(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`, {
      signal: ctx.signal,
    });
    if (!res.ok) throw new AdapterError(`workable ${res.status} ${src.boardToken}`, "workable", res.status);
    return ((await res.json()) as { jobs?: WorkableJob[] }).jobs ?? [];
  },

  normalize(_src, j) {
    const location = [j.city, j.state, j.country].filter(Boolean).join(", ") || null;
    return {
      externalId: j.shortcode,
      title: j.title.trim(),
      url: j.url,
      location,
      remote: typeof j.telecommuting === "boolean" ? j.telecommuting : null,
      sourcePostedAt: toEpochMs(j.published_on ?? j.created_at ?? null),
      descriptionText: htmlToText(j.description),
    };
  },
};
