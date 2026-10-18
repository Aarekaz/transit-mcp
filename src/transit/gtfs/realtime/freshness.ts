export type FeedFreshness = "fresh" | "stale" | "expired" | "unavailable";

export function observationAge(timestamp: number | null | undefined, nowSeconds: number): number | null {
  return timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > nowSeconds ? null : nowSeconds - timestamp;
}

export function classifyManifestFreshness(timestamp: number | null | undefined, nowSeconds: number, freshThrough: number, staleThrough = Infinity): FeedFreshness {
  const age = observationAge(timestamp, nowSeconds);
  if (age === null) return 'unavailable';
  if (age <= freshThrough) return 'fresh';
  return age <= staleThrough ? 'stale' : 'expired';
}

export function classifyFreshness(
  producerTimestampSeconds: number | null | undefined,
  nowSeconds: number,
  pollIntervalSeconds: number,
): FeedFreshness {
  if (producerTimestampSeconds == null) return "unavailable";

  const ageSeconds = Math.max(0, nowSeconds - producerTimestampSeconds);
  const freshThrough = pollIntervalSeconds * 2 + 30;
  const staleThrough = Math.max(300, pollIntervalSeconds * 4);

  if (ageSeconds <= freshThrough) return "fresh";
  if (ageSeconds <= staleThrough) return "stale";
  return "expired";
}

export function sanitizeTransitText(value: string, maxLength = 500): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(0, maxLength));
}
