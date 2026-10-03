import type { ApiAts } from "../fingerprint.ts";
import type { Adapter } from "../types.ts";
import { ashby } from "./ashby.ts";
import { bamboohr } from "./bamboohr.ts";
import { greenhouse } from "./greenhouse.ts";
import { lever } from "./lever.ts";
import { oracle } from "./oracle.ts";
import { rippling } from "./rippling.ts";
import { successfactors } from "./successfactors.ts";
import { workable } from "./workable.ts";
import { workday } from "./workday.ts";

// SmartRecruiters deliberately absent: its robots.txt disallows crawlers, so those
// companies are tracked through their own career sites (custom adapter, Phase 6).
export const adapters: Record<ApiAts, Adapter<any>> = {
  workday,
  greenhouse,
  oracle,
  ashby,
  lever,
  successfactors,
  workable,
  rippling,
  bamboohr,
};
