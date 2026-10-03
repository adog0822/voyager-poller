// Title prefilter shared by the poller (drop non-student roles before anything is
// sent to D1). Phase 5 builds the full co-op classifier on top of this.

const STRONG = /\b(co-?op|coop|intern|interns|internship|internships|apprentice(ship)?|practicum|placement|work[- ]study)\b/i;
const STUDENT = /\bstudent\b/i;
// "Student" as a customer segment, not a role: "Student Loan Servicing Manager".
const STUDENT_AS_CUSTOMER = /\bstudent (loans?|success|affairs|services|experience|accounts?|financial|aid|enrollment|recruit\w*|housing|life)\b|\bfor students\b/i;

export function prefilter(title: string): boolean {
  if (STRONG.test(title)) return true;
  return STUDENT.test(title) && !STUDENT_AS_CUSTOMER.test(title);
}
