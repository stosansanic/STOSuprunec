import { SUPABASE_CONFIG } from "./project.config";

interface ProjectUsageProfile {
  organizationSlug: string;
  provisionedDiskBytes: number;
  verifiedOn: string;
}

// Public dashboard metadata supplied by the project owner, not a live tariff API.
// Key each profile by project ref: copying the app must not reuse another project's quota.
// Add a usage profile only after verifying the target project limits.
const PROJECT_USAGE_PROFILES: Readonly<Record<string, ProjectUsageProfile>> = {};

/** Local lookup only: links never send an additional Supabase API request. */
export function getSupabaseUsageTarget() {
  const ref = SUPABASE_CONFIG.projectId;
  const profile = Object.prototype.hasOwnProperty.call(PROJECT_USAGE_PROFILES, ref)
    ? PROJECT_USAGE_PROFILES[ref] : undefined;
  const projectUrl = ref
    ? `https://supabase.com/dashboard/project/${encodeURIComponent(ref)}`
    : "https://supabase.com/dashboard";
  return {
    href: profile
      ? `https://supabase.com/dashboard/org/${encodeURIComponent(profile.organizationSlug)}/usage?projectRef=${encodeURIComponent(ref)}`
      : projectUrl,
    provisionedDiskBytes: profile?.provisionedDiskBytes ?? null,
    verifiedOn: profile?.verifiedOn ?? null,
    hasUsageLink: Boolean(profile),
  };
}
