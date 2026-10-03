// Map a careers/job URL to a pollable source. Pure: no I/O, no Node APIs, so it
// runs in Workers, the GitHub Actions poller, and seed scripts alike.

export type ApiAts =
  | "successfactors"
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workday"
  | "oracle"
  | "workable"
  | "rippling"
  | "bamboohr";

/** Platforms with no usable public API: polled as HTML/JS pages (Phase 6). */
export type CustomPlatform =
  | "icims"
  | "taleo"
  | "jobvite"
  | "smartrecruiters"
  | "greenhouse-embed"
  | "unknown";

export type Fingerprint =
  | { ats: ApiAts; boardToken: string; config: Record<string, string>; careersUrl: string }
  | {
      ats: "custom";
      boardToken: string;
      config: { platform: CustomPlatform };
      careersUrl: string | null;
      /** Set when the URL alone can't give a pollable listing page. */
      needsReview?: string;
    };

const WORKDAY_LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;

function seg(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

/** Workday career sites that aren't the public job board (referral/internal portals). */
export const NON_PUBLIC_WORKDAY_SITE = /referral|internal|employee|equest|targeted|nonrecruit|alumni|contingent/i;

export function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.search = "";
  u.hostname = u.hostname.toLowerCase();
  let s = u.toString();
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function custom(
  platform: CustomPlatform,
  careersUrl: string | null,
  boardKey: string,
  needsReview?: string,
): Fingerprint {
  return {
    ats: "custom",
    boardToken: boardKey,
    config: { platform },
    careersUrl,
    ...(needsReview ? { needsReview } : {}),
  };
}

export function fingerprint(raw: string): Fingerprint | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const parts = seg(url);

  // Greenhouse hosted boards
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host === "job-boards.eu.greenhouse.io") {
    const token = parts[0] === "embed" ? url.searchParams.get("for") : parts[0];
    if (!token) return null;
    const t = token.toLowerCase();
    return { ats: "greenhouse", boardToken: t, config: {}, careersUrl: `https://job-boards.greenhouse.io/${t}` };
  }

  // Lever (US + EU)
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    if (!parts[0]) return null;
    const site = parts[0].toLowerCase();
    const region = host === "jobs.eu.lever.co" ? "eu" : "us";
    return {
      ats: "lever",
      boardToken: site,
      config: { region },
      careersUrl: `https://${host}/${site}`,
    };
  }

  // Ashby
  if (host === "jobs.ashbyhq.com") {
    if (!parts[0]) return null;
    const board = parts[0];
    return { ats: "ashby", boardToken: board.toLowerCase(), config: { board }, careersUrl: `https://jobs.ashbyhq.com/${board}` };
  }

  // Workday: {tenant}.wd{N}.myworkdayjobs.com/[locale/]{site}/...
  const wd = host.match(/^([a-z0-9-]+)\.wd(\d+)\.myworkdayjobs\.com$/);
  if (wd) {
    const [, tenant, n] = wd;
    const rest = WORKDAY_LOCALE.test(parts[0] ?? "") ? parts.slice(1) : parts;
    const site = rest[0];
    if (!site || site === "job" || site === "wday") return null;
    return {
      ats: "workday",
      boardToken: `${tenant}|wd${n}|${site.toLowerCase()}`,
      config: { tenant, wd: `wd${n}`, site },
      careersUrl: `https://${tenant}.wd${n}.myworkdayjobs.com/${site}`,
    };
  }
  // Workday alt host: wd{N}.myworkdaysite.com/[locale/]recruiting/{tenant}/{site}
  const wdSite = host.match(/^wd(\d+)\.myworkdaysite\.com$/);
  if (wdSite) {
    const rest = WORKDAY_LOCALE.test(parts[0] ?? "") ? parts.slice(1) : parts;
    if (rest[0] !== "recruiting" || !rest[1] || !rest[2]) return null;
    const [, tenant, site] = rest;
    const t = tenant.toLowerCase();
    return {
      ats: "workday",
      boardToken: `${t}|wd${wdSite[1]}|${site.toLowerCase()}`,
      config: { tenant: t, wd: `wd${wdSite[1]}`, site },
      careersUrl: `https://${t}.wd${wdSite[1]}.myworkdayjobs.com/${site}`,
    };
  }

  // Oracle Recruiting Cloud: {host}.fa.{dc}.oraclecloud.com/hcmUI/CandidateExperience/{lang}/sites/{site}
  const ora = host.match(/^([a-z0-9-]+)\.fa\.([a-z0-9-]+)\.oraclecloud\.com$/);
  if (ora) {
    const i = parts.indexOf("sites");
    const site = i >= 0 ? parts[i + 1] : undefined;
    if (!site) return null;
    const [, h, dc] = ora;
    return {
      ats: "oracle",
      boardToken: `${h}|${dc}|${site}`,
      config: { host: h, dc, siteNumber: site },
      careersUrl: `https://${h}.fa.${dc}.oraclecloud.com/hcmUI/CandidateExperience/en/sites/${site}`,
    };
  }

  // Workable
  if (host === "apply.workable.com") {
    const slug = parts[0];
    if (!slug || slug === "j" || slug === "api") return null;
    return { ats: "workable", boardToken: slug.toLowerCase(), config: { slug }, careersUrl: `https://apply.workable.com/${slug}` };
  }

  // Rippling
  if (host === "ats.rippling.com") {
    const slug = parts[0];
    if (!slug || slug === "api") return null;
    return { ats: "rippling", boardToken: slug.toLowerCase(), config: { slug }, careersUrl: `https://ats.rippling.com/${slug}/jobs` };
  }

  // BambooHR
  const bamboo = host.match(/^([a-z0-9-]+)\.bamboohr\.com$/);
  if (bamboo && bamboo[1] !== "www" && bamboo[1] !== "api") {
    const slug = bamboo[1];
    return { ats: "bamboohr", boardToken: slug, config: { slug }, careersUrl: `https://${slug}.bamboohr.com/careers` };
  }

  // ---- No public API: custom pages (Phase 6) ----
  if (host.endsWith(".icims.com")) {
    const base = `https://${host}/jobs/search`;
    return custom("icims", base, base);
  }
  if (host.endsWith(".taleo.net")) {
    const i = parts.indexOf("careersection");
    const section = i >= 0 ? parts[i + 1] : undefined;
    const base = section ? `https://${host}/careersection/${section}/jobsearch.ftl` : null;
    return custom("taleo", base, base ?? normalizeUrl(raw), base ? undefined : "taleo-section-unknown");
  }
  if (host === "jobs.jobvite.com") {
    if (!parts[0]) return null;
    const base = `https://jobs.jobvite.com/${parts[0].toLowerCase()}/jobs`;
    return custom("jobvite", base, base);
  }
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") {
    // robots.txt disallows crawling SmartRecruiters: track via the company's own site.
    const id = parts[0] ?? "unknown";
    return custom("smartrecruiters", null, `smartrecruiters:${id.toLowerCase()}`, "smartrecruiters-needs-company-careers-url");
  }
  // SAP SuccessFactors Recruiting Marketing sites live on company domains; the
  // `ats=successfactors` marker identifies them. They expose /services/rss/job/.
  if (url.searchParams.get("ats") === "successfactors" || host.includes("successfactors") || host.includes("sapsf")) {
    return { ats: "successfactors", boardToken: host, config: { host }, careersUrl: url.origin };
  }
  if (url.searchParams.has("gh_jid")) {
    // Greenhouse embedded on the company's own domain; board token not in the URL.
    const base = `${url.origin}${url.pathname}`.replace(/\/$/, "");
    return custom("greenhouse-embed", base, normalizeUrl(base), "greenhouse-embed-token-unknown");
  }

  // Unknown platform: one source per company site (the job URL itself isn't a listing page).
  return custom("unknown", null, `site:${host.replace(/^www\./, "")}`, "needs-careers-url");
}
