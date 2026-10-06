// Company facts from Wikidata (CC0): employee count and sitelink count (a notability
// signal). Runs in the poller, a few companies per run, serially, per Wikimedia API
// etiquette (descriptive User-Agent, no parallel requests).

export type CompanyFacts = { wikidataId: string | null; employees: number | null; sitelinks: number | null; revenueUsd: number | null; isPublic: boolean | null };
const NONE: CompanyFacts = { wikidataId: null, employees: null, sitelinks: null, revenueUsd: null, isPublic: null };

type Claim = {
  rank?: string;
  mainsnak?: { datavalue?: { value?: unknown } };
  qualifiers?: Record<string, { datavalue?: { value?: { time?: string } } }[]>;
};
type Entity = {
  id: string;
  descriptions?: { en?: { value?: string } };
  claims?: Record<string, Claim[]>;
  sitelinks?: Record<string, unknown>;
};

const API = "https://www.wikidata.org/w/api.php";
const BUSINESS = /\b(compan(y|ies)|corporation|manufacturer|bank|firm|conglomerate|retailer|insurer|business|enterprise|multinational|organi[sz]ation|agency|university|hospital|laborator(y|ies)|developer|publisher|airline|automaker|consultancy|brand|subsidiary|startup|maker|provider|operator|utility|nonprofit|institute|health system)\b/i;
const NOT_COMPANY = /\b(given name|surname|family name|film|album|song|single|village|river|human|disambiguation|episode|novel|species|asteroid|television series|video game|painting|character)\b/i;

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

const USD = "http://www.wikidata.org/entity/Q4917";

/** Latest quantity for a property: preferred rank first, then the newest "point in time" qualifier. */
function latestQuantity(e: Entity, prop: string, unit?: string): number | null {
  const claims = e.claims?.[prop] ?? [];
  const parsed = claims
    .map((c) => {
      const v = c.mainsnak?.datavalue?.value as { amount?: string; unit?: string } | undefined;
      const n = v?.amount && (!unit || v.unit === unit) ? Number(v.amount) : NaN;
      const t = c.qualifiers?.P585?.[0]?.datavalue?.value?.time ?? "";
      return { n, t, preferred: c.rank === "preferred" };
    })
    .filter((x) => Number.isFinite(x.n) && x.n > 0);
  if (!parsed.length) return null;
  parsed.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.t.localeCompare(a.t));
  return Math.round(parsed[0].n);
}

export const employeesOf = (e: Entity) => latestQuantity(e, "P1128");
/** Revenue in USD only (other currencies would need FX rates). */
export const revenueUsdOf = (e: Entity) => latestQuantity(e, "P2139", USD);

/** Pick the entity that is this company: website match beats everything; people, films and places lose. */
export function pickCompany(entities: Entity[], domain: string | null): Entity | null {
  let best: { e: Entity; score: number } | null = null;
  for (const e of entities) {
    const desc = e.descriptions?.en?.value ?? "";
    if (NOT_COMPANY.test(desc)) continue;
    let score = 0;
    const sites = (e.claims?.P856 ?? []).map((c) => host(String(c.mainsnak?.datavalue?.value ?? ""))).filter(Boolean);
    if (domain && sites.some((h) => h === domain || h!.endsWith(`.${domain}`) || domain.endsWith(`.${h}`))) score += 4;
    if (e.claims?.P1128) score += 2;
    if (e.claims?.P452 || e.claims?.P159 || e.claims?.P1454 || e.claims?.P414) score += 1;
    if (BUSINESS.test(desc)) score += 1;
    if (score >= 2 && (!best || score > best.score)) best = { e, score };
  }
  return best?.e ?? null;
}

export async function companyFacts(name: string, domain: string | null, opts: { userAgent: string; signal?: AbortSignal }): Promise<CompanyFacts> {
  const headers = { "User-Agent": opts.userAgent, Accept: "application/json" };
  const search = new URL(API);
  search.search = new URLSearchParams({ action: "wbsearchentities", search: name, language: "en", type: "item", limit: "5", format: "json" }).toString();
  const s = await fetch(search, { headers, signal: opts.signal });
  if (!s.ok) throw new Error(`wikidata search ${s.status}`);
  const ids = (((await s.json()) as { search?: { id: string }[] }).search ?? []).map((r) => r.id).slice(0, 5);
  if (!ids.length) return NONE;
  const get = new URL(API);
  get.search = new URLSearchParams({ action: "wbgetentities", ids: ids.join("|"), props: "claims|sitelinks|descriptions", languages: "en", format: "json" }).toString();
  const g = await fetch(get, { headers, signal: opts.signal });
  if (!g.ok) throw new Error(`wikidata entities ${g.status}`);
  const entities = Object.values(((await g.json()) as { entities?: Record<string, Entity> }).entities ?? {});
  // Keep search order (relevance) for ties.
  entities.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  const e = pickCompany(entities, domain?.replace(/^www\./, "").toLowerCase() ?? null);
  if (!e) return NONE;
  return {
    wikidataId: e.id,
    employees: employeesOf(e),
    sitelinks: Object.keys(e.sitelinks ?? {}).length,
    revenueUsd: revenueUsdOf(e),
    // P414 = stock exchange listing.
    isPublic: !!e.claims?.P414?.length,
  };
}
