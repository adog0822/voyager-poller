import { AdapterError, type Adapter } from "../types.ts";
import { htmlToText, toEpochMs } from "../text.ts";

// Oracle Recruiting Cloud (public candidate-experience REST):
//   GET https://{host}.fa.{dc}.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions
//       ?onlyData=true&expand=requisitionList.secondaryLocations
//       &finder=findReqs;siteNumber={site},limit=25,offset=N,sortBy=POSTING_DATES_DESC,keyword={term}
//   Detail: recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id="{id}",siteNumber={site}

export type OracleReq = {
  Id: string;
  Title: string;
  PostedDate?: string;
  PrimaryLocation?: string;
  WorkplaceTypeCode?: string;
  ShortDescriptionStr?: string;
};

const LIMIT = 25;
// Oracle keyword search is full-text with stemming: "intern" also hits "internal"/
// "international" in descriptions (hundreds of results). Results are newest-first and
// the poller only needs new postings, so the noisy term gets just its first pages.
const SEARCH_TERMS: [keyword: string, maxPages: number][] = [
  ["co-op", 8],
  ["internship", 8],
  ["intern", 2],
];

function origin(src: { config: Record<string, string>; boardToken: string }) {
  const { host, dc, siteNumber } = src.config;
  if (!host || !dc || !siteNumber) throw new AdapterError(`bad oracle config ${src.boardToken}`, "oracle");
  return { base: `https://${host}.fa.${dc}.oraclecloud.com`, siteNumber };
}

export const oracle: Adapter<OracleReq> = {
  ats: "oracle",

  async fetchList(src, ctx) {
    const { base, siteNumber } = origin(src);
    const seen = new Map<string, OracleReq>();
    for (const [keyword, maxPages] of SEARCH_TERMS) {
      for (let page = 0; page < maxPages; page++) {
        const finder = `findReqs;siteNumber=${siteNumber},limit=${LIMIT},offset=${page * LIMIT},sortBy=POSTING_DATES_DESC,keyword=${encodeURIComponent(keyword)}`;
        const url = `${base}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`;
        const res = await ctx.fetch(url, { signal: ctx.signal });
        if (!res.ok) throw new AdapterError(`oracle ${res.status} ${src.boardToken}`, "oracle", res.status);
        const item = ((await res.json()) as { items?: { TotalJobsCount?: number; requisitionList?: OracleReq[] }[] }).items?.[0];
        const reqs = item?.requisitionList ?? [];
        for (const r of reqs) seen.set(r.Id, r);
        if (reqs.length < LIMIT || (page + 1) * LIMIT >= (item?.TotalJobsCount ?? 0)) break;
      }
    }
    return [...seen.values()];
  },

  normalize(src, r) {
    const { base, siteNumber } = origin(src);
    return {
      externalId: r.Id,
      title: r.Title.trim(),
      url: `${base}/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${r.Id}`,
      location: r.PrimaryLocation?.trim() || null,
      remote: r.WorkplaceTypeCode ? r.WorkplaceTypeCode === "ORA_REMOTE" : null,
      sourcePostedAt: toEpochMs(r.PostedDate ?? null),
      descriptionText: htmlToText(r.ShortDescriptionStr),
    };
  },

  async fetchDetail(src, posting, ctx) {
    const { base, siteNumber } = origin(src);
    const url = `${base}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${encodeURIComponent(posting.externalId)}%22,siteNumber=${siteNumber}`;
    const res = await ctx.fetch(url, { signal: ctx.signal });
    if (!res.ok) throw new AdapterError(`oracle detail ${res.status}`, "oracle", res.status);
    const d = ((await res.json()) as { items?: Record<string, string>[] }).items?.[0] ?? {};
    const text = [d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr]
      .map((h) => htmlToText(h))
      .filter(Boolean)
      .join("\n\n");
    return { descriptionText: text || null };
  },
};
