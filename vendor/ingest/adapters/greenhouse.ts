import { AdapterError, type Adapter } from "../types.ts";
import { htmlToText, toEpochMs } from "../text.ts";

// GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs           (list, no content)
// GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}      (detail with content)
// `first_published` is the real post date; `updated_at` changes on every edit.

export type GreenhouseJob = {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  first_published?: string | null;
  updated_at?: string;
};

const API = "https://boards-api.greenhouse.io/v1/boards";

export const greenhouse: Adapter<GreenhouseJob> = {
  ats: "greenhouse",

  async fetchList(src, ctx) {
    const res = await ctx.fetch(`${API}/${src.boardToken}/jobs`, { signal: ctx.signal });
    if (!res.ok) throw new AdapterError(`greenhouse ${res.status} ${src.boardToken}`, "greenhouse", res.status);
    return ((await res.json()) as { jobs?: GreenhouseJob[] }).jobs ?? [];
  },

  normalize(_src, j) {
    const loc = j.location?.name?.trim() || null;
    return {
      externalId: String(j.id),
      title: j.title.trim(),
      url: j.absolute_url,
      location: loc,
      remote: loc ? /remote/i.test(loc) : null,
      sourcePostedAt: toEpochMs(j.first_published ?? null),
      descriptionText: null,
    };
  },

  async fetchDetail(src, posting, ctx) {
    const res = await ctx.fetch(`${API}/${src.boardToken}/jobs/${posting.externalId}`, { signal: ctx.signal });
    if (!res.ok) throw new AdapterError(`greenhouse detail ${res.status}`, "greenhouse", res.status);
    const d = (await res.json()) as { content?: string };
    return { descriptionText: htmlToText(d.content) };
  },
};
