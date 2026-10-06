// Dependency-free so the web client can import labels without zod.
export const FIELDS = [
  "software",
  "data_ai",
  "cyber_it",
  "hardware_ee",
  "mech_aero",
  "civil_env",
  "chem_bio_eng",
  "life_sci_health",
  "finance_acct",
  "consulting_strategy",
  "marketing_comms",
  "product_design",
  "ops_supply_chain",
  "people_hr",
  "legal_policy_gov",
  "sales_bd",
] as const;
export type Field = (typeof FIELDS)[number];

export const FIELD_LABELS: Record<Field, string> = {
  software: "Software",
  data_ai: "Data & AI",
  cyber_it: "Cybersecurity & IT",
  hardware_ee: "Hardware & electrical",
  mech_aero: "Mechanical & aerospace",
  civil_env: "Civil & environmental",
  chem_bio_eng: "Chemical & bioengineering",
  life_sci_health: "Life sciences & health",
  finance_acct: "Finance & accounting",
  consulting_strategy: "Consulting & strategy",
  marketing_comms: "Marketing & comms",
  product_design: "Product & design",
  ops_supply_chain: "Operations & supply chain",
  people_hr: "People & HR",
  legal_policy_gov: "Legal, policy & government",
  sales_bd: "Sales & partnerships",
};
