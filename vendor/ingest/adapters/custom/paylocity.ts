import { AdapterError, type Adapter } from "../../types.ts";
import { htmlToText, toEpochMs } from "../../text.ts";

// Paylocity boards: https://recruiting.paylocity.com/Recruiting/Jobs/All/{guid}/{name}
// The board page embeds every open job as `window.pageData = {...}` (Jobs[]). No robots.txt
// on that host (404 = no restrictions). Job pages: /Recruiting/Jobs/Details/{JobId}.

export type PaylocityJob = {
  JobId: number;
  JobTitle: string;
  LocationName?: string | null;
  PublishedDate?: string | null;
  Description?: string | null;
  HiringDepartment?: string | null;
  IsRemote?: boolean | null;
  IsInternal?: boolean | null;
};

const HOST = "https://recruiting.paylocity.com";

/** Pulls the `window.pageData` object out of the board HTML (string-aware brace matching, bounded). */
export function parsePaylocityPage(html: string): PaylocityJob[] {
  const marker = html.indexOf("window.pageData");
  if (marker < 0) return [];
  const start = html.indexOf("{", marker);
  if (start < 0) return [];
  let depth = 0;
  let inStr = false;
  let end = -1;
  const limit = Math.min(html.length, start + 5_000_000);
  for (let i = start; i < limit; i++) {
    const c = html[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) return [];
  try {
    const data = JSON.parse(html.slice(start, end)) as { Jobs?: PaylocityJob[] };
    return (data.Jobs ?? []).filter((j) => j && j.JobId && j.JobTitle && !j.IsInternal);
  } catch {
    return [];
  }
}

export const paylocity: Adapter<PaylocityJob> = {
  ats: "custom",
  async fetchList(src, ctx) {
    const guid = src.boardToken.replace(/^paylocity:/, "");
    const url = `${HOST}/Recruiting/Jobs/All/${encodeURIComponent(guid)}`;
    const res = await ctx.fetch(url, { signal: ctx.signal, headers: { Accept: "text/html" } });
    if (!res.ok) throw new AdapterError(`paylocity ${res.status} ${guid}`, "custom", res.status);
    return parsePaylocityPage(await res.text());
  },
  normalize(_src, j) {
    const location = j.LocationName?.trim() || null;
    return {
      externalId: String(j.JobId),
      title: j.JobTitle.trim(),
      url: `${HOST}/Recruiting/Jobs/Details/${j.JobId}`,
      location,
      remote: typeof j.IsRemote === "boolean" ? j.IsRemote : location ? /remote/i.test(location) : null,
      sourcePostedAt: toEpochMs(j.PublishedDate ?? null),
      descriptionText: htmlToText(j.Description) ?? null,
      department: j.HiringDepartment?.trim() || null,
    };
  },
};
