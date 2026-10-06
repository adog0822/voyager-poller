// Co-op detection. `prefilter` (title only) runs in the poller to drop non-student roles
// before anything reaches D1. `classifyRules` scores co-op likelihood and extracts the
// NU cycle from title + description; the Worker's LLM step only handles the ambiguous
// middle band and eligibility (PLAN.md Phase 5).

const STRONG = /\b(co-?ops?|coops?|intern|interns|internship|internships|apprentice(ship)?|practicum|placement|work[- ]study)\b/i;
const STUDENT = /\bstudent\b/i;
// "Student" as a customer segment, not a role: "Student Loan Servicing Manager".
const STUDENT_AS_CUSTOMER = /\bstudent (loans?|success|affairs|services|experience|accounts?|financial|aid|enrollment|recruit\w*|housing|life)\b|\bfor students\b/i;

export function prefilter(title: string): boolean {
  if (STRONG.test(title)) return true;
  return STUDENT.test(title) && !STUDENT_AS_CUSTOMER.test(title);
}

/** NU co-op cycles: Spring (Jan–Jun, or Jan–Apr for 4 months), Summer (May–Aug), Fall (Jul–Dec). */
export type Cycle = "spring" | "summer" | "fall" | "unknown";

export type RuleResult = {
  isCoop: boolean;
  confidence: number; // 0..1
  cycle: Cycle;
  cycleYear: number | null;
  durationMonths: 4 | 6 | 8 | null;
  /** Why: short tags for debugging and the "why this matched" UI. */
  signals: string[];
};

const COOP_WORD = /\bco-?ops?\b|\bcoops?\b/i;
const INTERN_WORD = /\bintern(s|ship|ships)?\b/i;
const COOP_COMPANY = /\bco-?op(erative)?\b/i; // grocery / credit-union "Co-op" employers
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_RANGE = new RegExp(`\\b(${MONTHS})\\.?\\s*(?:20\\d\\d\\s*)?(?:-|–|—|to|through|until)\\s*(${MONTHS})\\b`, "i");
const SEASON_YEAR = /\b(spring|summer|fall|autumn|winter)\b[\s/,'-]*(?:co-?op\s*|term\s*|semester\s*)?(20\d\d)\b|\b(20\d\d)\s*(spring|summer|fall|autumn|winter)\b/i;
const SEASON = /\b(spring|summer|fall|autumn|winter)\b/i;
// Role duration only: "6-month", "6 month co-op", "for 6 months", "(8 Months)". Not
// "graduating within 6 months" or "6 months of experience".
const N = "(4|four|6|six|8|eight)";
// UK/EU industrial placements: 12 months, not an NU co-op (4/6/8 months).
const PLACEMENT_YEAR = /\b(placement year|year[- ]long placement|industrial placement|sandwich (year|placement)|12[- ]month (placement|internship))\b/i;
const DURATION = new RegExp(
  [
    `\\b${N}-months?\\b`,
    `\\b${N}\\s+months?\\s+(?:co-?op|intern(?:ship)?|term|position|placement|assignment|role|program|contract)\\b`,
    `\\b(?:for|lasting|spanning|duration(?: of)?:?|length(?: of)?:?)\\s+${N}\\s+months?\\b`,
    `\\(${N}\\s+months?\\)`,
  ].join("|"),
  "i",
);

const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = (m: string) => MONTH_INDEX[m.toLowerCase().slice(0, 3)];

function seasonToCycle(season: string): Cycle {
  const s = season.toLowerCase();
  if (s === "spring" || s === "winter") return "spring"; // Canadian "Winter" (Jan–Apr) = NU Spring 4-month
  if (s === "summer") return "summer";
  return "fall";
}

// In a title, any "N months" describes the role itself.
const TITLE_DURATION = new RegExp(`\\b${N}[\\s-]*(?:month|mo)s?\\b`, "i");

function durationFrom(text: string, re: RegExp = DURATION): 4 | 6 | 8 | null {
  const m = text.match(re);
  const word = m?.slice(1).find(Boolean);
  if (!word) return null;
  return ({ "4": 4, four: 4, "6": 6, six: 6, "8": 8, eight: 8 } as const)[word.toLowerCase() as "4"];
}

export function classifyRules(input: { title: string; description?: string | null; companyName?: string | null }): RuleResult {
  const title = input.title;
  const desc = (input.description ?? "").slice(0, 8000);
  const signals: string[] = [];
  let confidence = 0;

  const titleCoop = COOP_WORD.test(title);
  const companyIsCoop = !!input.companyName && COOP_COMPANY.test(input.companyName);
  if (titleCoop && !(companyIsCoop && !/co-?op\s*(\/|or|&)?\s*intern|\bco-?op (student|position|term|program)/i.test(title))) {
    confidence = 0.9;
    signals.push("title:co-op");
  } else if (INTERN_WORD.test(title) || /apprentic|practicum|placement|work[- ]study|student/i.test(title)) {
    confidence = 0.2;
    signals.push("title:student-role");
  }

  const both = `${title}\n${desc}`;
  const range = both.match(MONTH_RANGE);
  const duration = durationFrom(title, TITLE_DURATION) ?? durationFrom(desc);
  const seasonYear = both.match(SEASON_YEAR);

  if (confidence < 0.9) {
    if (/\bco-?op\b/i.test(desc) && !/\bco-?operative\b/i.test(desc.match(/\bco-?op\w*/i)?.[0] ?? "")) {
      confidence += 0.35;
      signals.push("desc:co-op");
    }
    if (duration === 6 || duration === 8) {
      confidence += 0.25;
      signals.push(`duration:${duration}mo`);
    }
    if (range) {
      const a = monthNum(range[1]);
      const b = monthNum(range[2]);
      const span = ((b - a + 12) % 12) + 1;
      if (span >= 4) {
        confidence += 0.15;
        signals.push(`range:${range[1]}-${range[2]}`);
      }
    }
    if (/\bnortheastern\b/i.test(desc)) {
      confidence += 0.1;
      signals.push("desc:northeastern");
    }
  }
  if (PLACEMENT_YEAR.test(title) && !COOP_WORD.test(title)) {
    confidence = 0.1;
    signals.push("placement-year");
  }
  confidence = Math.min(1, Math.round(confidence * 100) / 100);

  // Cycle: an explicit month range beats a season word.
  let cycle: Cycle = "unknown";
  let cycleYear: number | null = null;
  if (range) {
    const a = monthNum(range[1]);
    cycle = a <= 3 ? "spring" : a <= 6 ? "summer" : "fall";
    if (a === 5 || a === 6) cycle = "summer";
    if (a >= 7) cycle = "fall";
  }
  if (cycle === "unknown") {
    // First season named is the start: "Summer/Fall 2026" starts in Summer.
    const s = title.match(SEASON) ?? (seasonYear ? null : desc.match(SEASON));
    if (s) cycle = seasonToCycle(s[1]);
    else if (seasonYear) cycle = seasonToCycle(seasonYear[1] ?? seasonYear[4]);
  }
  if (seasonYear) cycleYear = Number(seasonYear[2] ?? seasonYear[3]);
  if (!cycleYear) {
    const y = title.match(/\b(20[2-3]\d)\b/) ?? both.match(new RegExp(`\\b(?:${MONTHS})\\.?,?\\s*(20[2-3]\\d)\\b`, "i"));
    if (y) cycleYear = Number(y[1]);
  }

  let durationMonths = duration;
  if (!durationMonths && range) {
    const span = ((monthNum(range[2]) - monthNum(range[1]) + 12) % 12) + 1;
    if (span >= 3 && span <= 9) durationMonths = span <= 4 ? 4 : span <= 6 ? 6 : 8;
  }

  return { isCoop: confidence >= 0.6, confidence, cycle, cycleYear, durationMonths, signals };
}
