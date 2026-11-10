/** Keep the legacy serialization for occurrence identity while storing only a digest.
 * An interrupted delivery created by the previous worker must retain its generation.
 */
export async function reminderResultDigest(serialized: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
  return `sha256:v1:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function matchesReminderResult(previous: unknown, digest: string): Promise<boolean> {
  if (typeof previous !== "string" || !previous) return false;
  if (previous.startsWith("sha256:v1:")) return previous === digest;
  // Old rows contain JSON.stringify(result), not a cryptographic hash.
  return await reminderResultDigest(previous) === digest;
}
