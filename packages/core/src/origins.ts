/**
 * The concrete origins a provider's auth manifest names — the sites a user
 * consents to when they run `mastro login <provider>`.
 */
import type { AuthManifest } from "./types.ts";

/** `launch.expected_origins` plus `permissions.host_permissions`, minus wildcard hosts. */
export function manifestOrigins(manifest: AuthManifest): string[] {
  const origins = new Set<string>();
  const patterns = [...manifest.launch.expected_origins, ...manifest.permissions.host_permissions];
  for (const pattern of patterns) {
    let url: URL;
    try {
      url = new URL(pattern.replace(/\/\*$/, "/"));
    } catch {
      continue;
    }
    if (!url.hostname.includes("*")) origins.add(url.origin);
  }
  return [...origins];
}
