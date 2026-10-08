import { AdapterError, type Adapter, type SourceConfig } from "../../types.ts";
import { amazon } from "./amazon.ts";
import { icims } from "./icims.ts";
import { jazzhr } from "./jazzhr.ts";
import { jibe } from "./jibe.ts";
import { jobvite } from "./jobvite.ts";
import { microsoft } from "./microsoft.ts";
import { paylocity } from "./paylocity.ts";

// `ats = "custom"` sources pick an implementation by `config.platform`.
// Not supported (stay disabled): taleo (portal-id REST), smartrecruiters (robots),
// avature/wayfair (robots + bot protection), unknown one-off sites.
export const CUSTOM_PLATFORMS = { amazon, microsoft, icims, jobvite, jazzhr, jibe, paylocity } as const;
export type CustomPlatformName = keyof typeof CUSTOM_PLATFORMS;
export const SUPPORTED_CUSTOM_PLATFORMS = Object.keys(CUSTOM_PLATFORMS) as CustomPlatformName[];

function pick(src: SourceConfig): Adapter<unknown> {
  const impl = CUSTOM_PLATFORMS[src.config.platform as CustomPlatformName];
  if (!impl) throw new AdapterError(`unsupported custom platform ${src.config.platform}`, "custom");
  return impl as Adapter<unknown>;
}

export const custom: Adapter<unknown> = {
  ats: "custom",
  fetchList: async (src, ctx) => pick(src).fetchList(src, ctx),
  normalize: (src, raw, ctx) => pick(src).normalize(src, raw, ctx),
  fetchDetail: async (src, posting, ctx) => {
    const impl = pick(src);
    return impl.fetchDetail ? impl.fetchDetail(src, posting, ctx) : {};
  },
};
