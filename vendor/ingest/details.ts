// Co-op facts from a posting, by rules only (runs in the poller, no CPU limit): field,
// pay, GPA, degree, class/grad years, majors, work authorization, prior experience.
// The Worker's LLM step only fills what these leave null. Descriptions are never stored.
import { z } from "zod";

import { FIELDS, type Field } from "./fields.ts";

export { FIELD_LABELS, FIELDS, type Field } from "./fields.ts";

// First match wins, so specific buckets come before broad ones (data before software,
// security before software, finance before consulting).
const FIELD_RULES: [Field, RegExp][] = [
  ["data_ai", /\b(data scien\w*|applied (?:ai|ml|research)|world models?|research scientist|machine learning|ml|ai|artificial intelligence|deep learning|llms?|nlp|computer vision|analytics|data (analyst|engineer\w*)|quant\w*|statistic\w*|bioinformatic\w*)\b/i],
  ["cyber_it", /\b(cyber\s?security|security (engineer|analyst)|infosec|soc analyst|penetration|application security|it (support|ops|operations|analyst)|help ?desk|network (admin\w*|engineer)|sysadmin|it support technician)\b/i],
  ["hardware_ee", /\b(electrical|electronics?|hardware|firmware|embedded|asic|fpga|rf|pcb|silicon|semiconductor|power systems|controls engineer\w*|robotics)\b/i],
  ["software", /\b(software|swe|sde|developer|full[- ]?stack|front[- ]?end|back[- ]?end|web|mobile|ios|android|devops|sre|site reliability|cloud|platform engineer\w*|programmer|qa (engineer|automation)|quality assurance|test automation)\b/i],
  ["mech_aero", /\b(mechanical|aerospace|aeronautic\w*|propulsion|thermal|structural dynamics|manufacturing engineer\w*|industrial engineer\w*|mechatronic\w*|design engineer\w*)\b/i],
  ["civil_env", /\b(civil|structural engineer\w*|geotechnical|transportation engineer\w*|environmental (engineer|scien)\w*|construction|water resources|surveying)\b/i],
  ["chem_bio_eng", /\b(chemical engineer\w*|process engineer\w*|bioprocess|biomedical engineer\w*|bioengineer\w*|materials? (scien|engineer)\w*|formulation)\b/i],
  ["finance_acct", /\b(financ\w*|accounting|accountant|audit\w*|tax|treasury|fp&a|investment\w*|equity research|private equity|venture|banking|wealth|actuar\w*|underwrit\w*|credit|risk analyst|fund accounting)\b/i],
  ["life_sci_health", /\b(research (assistant|associate|technician)|lab(oratory)?|biolog\w*|chemist(ry)?|clinical|pharma\w*|nurs\w*|physical therap\w*|health\w*|medical|neuro\w*|immunolog\w*|biotech\w*)\b/i],
  ["consulting_strategy", /\b(consult\w*|strategy|strategic|business analyst|corporate development|advisory|management analyst)\b/i],
  ["product_design", /\b(product manag\w*|product owner|ux|ui|user experience|product design\w*|graphic design\w*|interaction design\w*|user research\w*)\b/i],
  ["marketing_comms", /\b(marketing|marketer|brand|communications?|public relations|social media|content|seo|digital media|journalism|editorial|copywrit\w*)\b/i],
  ["ops_supply_chain", /\b(operations|supply chain|logistics|procurement|sourcing|purchasing|inventory|planning analyst|fulfillment|lean|six sigma|upgrade and migration)\b/i],
  ["people_hr", /\b(human resources|hr|people (ops|operations|team)|talent|recruit\w*|benefits|compensation analyst)\b/i],
  ["legal_policy_gov", /\b(legal|paralegal|law|compliance|policy|government affairs|public affairs|regulatory)\b/i],
  ["sales_bd", /\b(sales|business development|account (executive|manager)|sdr|bdr|partnerships?|customer success)\b/i],
];

// Departments that only say "this is a student job".
const GENERIC_DEPT = /^(early (career|talent)s?|university( (recruiting|programs?|relations))?|emerging talent|univ\w* employment|campus|students?|interns?(hips?)?|co-?ops?|all departments|general|other)$/i;

export function fieldFrom(text: string | null | undefined): Field | null {
  if (!text) return null;
  for (const [f, re] of FIELD_RULES) if (re.test(text)) return f;
  return null;
}

/** Title first, then the ATS department/category (skipping generic student buckets). */
export function classifyField(title: string, department?: string | null): Field | null {
  const t = title.replace(/\b(co-?op|intern(ship)?|student|summer|spring|fall|winter|20\d\d)\b/gi, " ");
  const fromTitle = fieldFrom(t);
  if (fromTitle) return fromTitle;
  const dept = department?.replace(/^.*?\s-\s/, "").trim(); // "Emerging Talent - SWE" → "SWE"
  if (dept && !GENERIC_DEPT.test(dept)) return fieldFrom(dept) ?? fieldFrom(department);
  return null;
}

// ---------- Pay ----------

export const PayUnit = z.enum(["hour", "week", "month", "year"]);
export type PayUnit = z.infer<typeof PayUnit>;
export const Pay = z.object({
  min: z.number().positive().max(10_000_000),
  max: z.number().positive().max(10_000_000),
  unit: PayUnit,
  currency: z.string().max(3),
  source: z.enum(["ats", "text"]),
});
export type Pay = z.infer<typeof Pay>;

const HOURS_PER: Record<PayUnit, number> = { hour: 1, week: 40, month: 2080 / 12, year: 2080 };
export const toHourly = (amount: number, unit: PayUnit) => Math.round((amount / HOURS_PER[unit]) * 100) / 100;

/** Unit from magnitude when the source doesn't say (Greenhouse pay ranges have no unit). */
export function guessUnit(amount: number): PayUnit {
  if (amount <= 300) return "hour";
  if (amount < 20_000) return "month";
  return "year";
}

export function unitFrom(s: string | null | undefined): PayUnit | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/hour|hr\b|hourly|wage/.test(t)) return "hour";
  if (/week|wk\b/.test(t)) return "week";
  if (/month|mo\b|monthly/.test(t)) return "month";
  if (/year|yr\b|annum|annual|salary/.test(t)) return "year";
  return null;
}

const AMT = String.raw`(?:US\$|C\$|CA\$|\$)\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\s?[kK]?|\d{1,3}(?:,\d{3})+(?:\.\d{2})?\s?USD`;
const PAY_RE = new RegExp(
  String.raw`(${AMT})(?:\s{0,3}(?:-|–|—|to|and)\s{0,3}(${AMT}))?(?:\s{0,2}(?:USD|CAD))?\s{0,2}(?:\/\s{0,2}|per\s{1,3}|an\s{1,3}|a\s{1,3})?(hour|hr|h|week|wk|month|mo|year|yr|annum|annually|hourly)?\b`,
  "gi",
);
const NOT_PAY = /\b(raised|funding|valuation|revenue|assets|customers|aum|market cap|billion|million|trillion|series [a-f])\b/i;
const UNIT_CONTEXT = /\b(hourly (?:rate|wage|pay)|pay rate|per hour|salary range|base (?:pay|salary)|annual|monthly (?:stipend|salary|pay)|stipend)\b/i;

function amount(s: string): number {
  const k = /k\s*$/i.test(s);
  const n = Number(s.replace(/[^\d.]/g, ""));
  return k ? n * 1000 : n;
}

export function payFromText(text: string | null | undefined): Pay | null {
  if (!text) return null;
  for (const m of text.slice(0, 20_000).matchAll(PAY_RE)) {
    // Same-sentence context only: "We raised $300M. Pay: $28/hr" is still pay.
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0).split(/[.!?\n]\s/).pop() ?? "";
    const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12);
    if (NOT_PAY.test(before) || /^\s*(million|billion|trillion|[MB]\b)/i.test(after)) continue;
    const lo = amount(m[1]);
    const hi = m[2] ? amount(m[2]) : lo;
    if (!(lo > 0) || hi < lo || lo < 10) continue;
    const ctx = text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + m[0].length + 30);
    const unit = unitFrom(m[3]) ?? unitFrom(ctx.match(UNIT_CONTEXT)?.[0]) ?? guessUnit(lo);
    const hourly = toHourly(lo, unit);
    if (hourly < 7 || hourly > 400) continue; // not a plausible student wage
    const currency = /C\$|CA\$|CAD/.test(m[0]) ? "CAD" : "USD";
    return { min: lo, max: hi, unit, currency, source: "text" };
  }
  return null;
}

// ---------- Eligibility ----------

export const PriorExperience = z.enum(["required", "preferred", "not_mentioned"]);
export const DegreeLevel = z.enum(["bs", "ms", "phd"]);

export const Details = z.object({
  field: z.enum(FIELDS).nullable(),
  department: z.string().max(120).nullable(),
  pay: Pay.nullable(),
  minGpa: z.number().min(2).max(4.3).nullable(),
  gpaRequired: z.boolean().nullable(),
  degreeLevels: z.array(DegreeLevel).max(3),
  classYears: z.array(z.string().max(30)).max(8),
  gradYears: z.array(z.number().int().min(2024).max(2035)).max(8),
  majors: z.array(z.string().max(80)).max(15),
  sponsorship: z.boolean().nullable(),
  citizenshipRequired: z.boolean().nullable(),
  usPersonRequired: z.boolean().nullable(),
  priorExperience: PriorExperience,
});
export type Details = z.infer<typeof Details>;

const PREF_HDR = /^\W{0,4}(preferred|bonus|nice[- ]to[- ]haves?|pluses|desired|ideally|additional qualifications)\b/i;
const REQ_HDR = /^\W{0,4}(minimum|basic|required|must[- ]haves?|requirements|qualifications|what you(?:'ll)? need|who you are|you have|eligibility)\b/i;
const PREF_WORDS = /\b(prefer\w*|a plus|bonus|nice to have|ideal(?:ly)?|desired|beneficial|advantageous)\b/i;

const GPA_A = /\b(?:gpa|grade point average)\b[^.\n]{0,25}?\b([234]\.\d{1,2})\b/i;
const GPA_B = /\b([234]\.\d{1,2})\s{0,2}(?:\/\s{0,2}4\.0{1,2})?\s{0,2}(?:\+|or (?:higher|above|better))?\s{0,2}(?:cumulative\s{0,2})?gpa\b/i;
const DEG_BS = /\b(b\.?s\.?|b\.?a\.?|bachelor'?s?|undergraduate|undergrad)\b/i;
const DEG_MS = /\b(m\.?s\.?(?!\s{0,2}(?:office|excel|word|teams|powerpoint|project|sql|access|azure|dynamics))|master'?s?|m\.?eng|mba)\b/i;
const DEG_PHD = /\bph\.?\s?d\.?\b|\bdoctoral\b|\bdoctorate\b/i;
const CLASS = /\b(freshman|freshmen|sophomores?|juniors?|seniors?|rising (?:sophomore|junior|senior)s?|(?:first|second|third|fourth|final|pre-?final|penultimate)[- ]year)\b/gi;
const GRAD = /\bgraduat\w*\b[^.\n]{0,60}?\b(20[23]\d)\b(?:[^.\n]{0,25}?\b(20[23]\d)\b)?/gi;
const MAJORS_SPAN = /\b(?:majoring in|major(?:s)? in|degree in|pursuing (?:a|an) [\w' ]{0,25}?in|studying|field of study:?|in (?:the )?field(?:s)? of)\s{1,3}([^.;\n:]{3,160})/i;
const NO_SPONSOR =
  /\b(?:not|unable to|cannot|can ?not|will not|won'?t|does not|do not)\s{1,3}(?:be able to\s{1,3})?(?:offer|provide|support|sponsor)\w*\s{1,3}(?:(?:visa|immigration|employment|work)\s{1,3})?(?:sponsorship|visas?)\b|\bwithout (?:the )?(?:need for |requiring )?(?:current or future |now or in the future )?(?:visa |employer |immigration )?sponsorship\b|\bsponsorship (?:is )?not (?:available|offered|provided)\b|\bnot eligible for (?:visa )?sponsorship\b/i;
const YES_SPONSOR = /\b(?:will|can|able to|happy to)\s{1,3}(?:offer|provide|support)\s{1,3}(?:visa\s{1,3})?sponsorship\b|\bsponsorship (?:is )?available\b|\b(?:cpt|opt)\b[^.\n]{0,30}\b(?:eligible|accepted|welcome)\b/i;
const CITIZEN = /\bmust be (?:a )?u\.?s\.? citizen\b|\bu\.?s\.? citizen(?:ship)?\b[^.\n]{0,40}\b(?:required|only|must)\b|\b(?:secret|top secret|ts\/sci) clearance\b|\bability to obtain (?:and maintain )?(?:a )?(?:security|government|secret) clearance\b/i;
const US_PERSON = /\b(itar|ear\b|export control\w*|u\.?s\.? persons?)\b/i;
const PRIOR_EXP =
  /\b(?:prior|previous|past|relevant)\s{1,3}(?:internship|co-?op|industry|professional|work)\s{1,3}(?:or (?:co-?op|internship)\s{1,3})?experience\b|\b(?:one|1|two|2|at least one|a)\s{1,3}(?:or more\s{1,3})?(?:previous|prior)?\s{0,3}(?:internships?|co-?ops?)\b[^.\n]{0,40}\b(?:experience|completed)\b|\bcompleted (?:at least )?(?:one|1|a) (?:prior )?(?:internship|co-?op)\b/i;

/** Splits into lines tagged by the most recent required/preferred section header. */
function sections(text: string): { line: string; pref: boolean }[] {
  let pref = false;
  return text.split(/\n+/).map((raw) => {
    const line = raw.trim();
    if (line.length < 60) {
      if (PREF_HDR.test(line)) pref = true;
      else if (REQ_HDR.test(line)) pref = false;
    }
    return { line, pref: pref || PREF_WORDS.test(line) };
  });
}

const MAJOR_STOP = /\b(or (a )?related( field)?|related (field|discipline)s?|equivalent|similar|etc|a|an|the|field)\b/gi;

function majorsFrom(text: string): string[] {
  const m = text.match(MAJORS_SPAN);
  if (!m) return [];
  return [
    ...new Set(
      m[1]
        .split(/,|\bor\b|\band\b|\/|;/i)
        .map((s) => s.replace(MAJOR_STOP, " ").replace(/\s+/g, " ").trim())
        .filter((s) => s.length >= 3 && s.length <= 60 && !/\d/.test(s)),
    ),
  ].slice(0, 12);
}

export function extractDetails(input: {
  title: string;
  description?: string | null;
  department?: string | null;
  structuredPay?: Pay | null;
}): Details {
  const desc = (input.description ?? "").slice(0, 20_000);
  const all = `${input.title}\n${desc}`;
  const lines = sections(desc);

  let minGpa: number | null = null;
  let gpaRequired: boolean | null = null;
  let priorExperience: Details["priorExperience"] = "not_mentioned";
  for (const { line, pref } of lines) {
    if (minGpa === null) {
      const g = line.match(GPA_A) ?? line.match(GPA_B);
      const v = g ? Number(g[1]) : NaN;
      if (v >= 2 && v <= 4.0) {
        minGpa = v;
        gpaRequired = !pref;
      }
    }
    if (PRIOR_EXP.test(line)) {
      const level = pref ? "preferred" : "required";
      if (priorExperience !== "required") priorExperience = level;
    }
  }

  const degreeLevels: Details["degreeLevels"] = [];
  if (DEG_BS.test(all)) degreeLevels.push("bs");
  if (DEG_MS.test(all)) degreeLevels.push("ms");
  if (DEG_PHD.test(all)) degreeLevels.push("phd");

  const classYears = [...new Set([...desc.matchAll(CLASS)].map((m) => m[1].toLowerCase().replace(/s$/, "").replace(/^freshmen$/, "freshman")))].slice(0, 8);
  const gradYears = new Set<number>();
  for (const m of desc.matchAll(GRAD)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let y = Math.min(a, b); y <= Math.max(a, b) && gradYears.size < 8; y++) if (y >= 2024 && y <= 2035) gradYears.add(y);
  }

  const noSponsor = NO_SPONSOR.test(desc);
  const sponsorship = noSponsor ? false : YES_SPONSOR.test(desc) ? true : null;
  const citizen = CITIZEN.test(desc);

  const pay = input.structuredPay ?? payFromText(desc);
  const majors = majorsFrom(desc);
  return {
    // Generic titles ("Engineering Co-op"): fall back to the majors the posting asks for.
    field: classifyField(input.title, input.department) ?? fieldFrom(majors.join(", ")),
    department: input.department?.slice(0, 120) ?? null,
    pay,
    minGpa,
    gpaRequired,
    degreeLevels,
    classYears,
    gradYears: [...gradYears].sort(),
    majors,
    sponsorship,
    citizenshipRequired: citizen ? true : null,
    usPersonRequired: !citizen && US_PERSON.test(desc) ? true : null,
    priorExperience,
  };
}
