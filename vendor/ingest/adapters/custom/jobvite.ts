import { AdapterError, type Adapter } from "../../types.ts";
import { decodeEntities, htmlToText } from "../../text.ts";

// Jobvite hosted career sites: server-rendered table of every job.
//   GET https://jobs.jobvite.com/{company}/jobs   (rows: td.jv-job-list-name / td.jv-job-list-location)

export type JobviteJob = { id: string; title: string; url: string; location: string | null };

export function parseJobviteList(html: string, company: string): JobviteJob[] {
  const out = new Map<string, JobviteJob>();
  const rowRe = /<tr[^<>]{0,500}>([\s\S]{0,8000}?)<\/tr>/gi;
  const co = company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const row of html.matchAll(rowRe)) {
    const a = row[1].match(new RegExp(`<a[^<>]*href="(/${co}/job/([A-Za-z0-9]+))"[^<>]*>([\\s\\S]{0,2000}?)</a>`, "i"));
    if (!a) continue;
    const loc = row[1].match(/class="jv-job-list-location"[^<>]*>([\s\S]{0,1000}?)<\/td>/i);
    const title = (htmlToText(a[3]) ?? "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    out.set(a[2], {
      id: a[2],
      title,
      url: `https://jobs.jobvite.com${decodeEntities(a[1])}`,
      location: loc ? (htmlToText(loc[1]) ?? "").replace(/\s+/g, " ").trim() || null : null,
    });
  }
  return [...out.values()];
}

const companyOf = (careersUrl: string | null | undefined, token: string) =>
  new URL(careersUrl ?? token).pathname.split("/").filter(Boolean)[0];

export const jobvite: Adapter<JobviteJob> = {
  ats: "custom",
  async fetchList(src, ctx) {
    const company = companyOf(src.careersUrl, src.boardToken);
    const res = await ctx.fetch(`https://jobs.jobvite.com/${company}/jobs`, { signal: ctx.signal, headers: { Accept: "text/html" } });
    if (!res.ok) throw new AdapterError(`jobvite ${res.status} ${company}`, "custom", res.status);
    return parseJobviteList(await res.text(), company);
  },
  normalize(_src, j) {
    return { externalId: j.id, title: j.title, url: j.url, location: j.location, remote: j.location ? /remote/i.test(j.location) : null, sourcePostedAt: null, descriptionText: null };
  },
  async fetchDetail(_src, posting, ctx) {
    const res = await ctx.fetch(posting.url, { signal: ctx.signal, headers: { Accept: "text/html" } });
    if (!res.ok) throw new AdapterError(`jobvite detail ${res.status}`, "custom", res.status);
    const html = await res.text();
    const m = html.match(/class="jv-job-detail-description"[^<>]*>([\s\S]{0,60000}?)<\/div>\s*(?:<div class="jv-job-detail-bottom|<\/div>)/i);
    return { descriptionText: htmlToText(m?.[1] ?? null) };
  },
};
