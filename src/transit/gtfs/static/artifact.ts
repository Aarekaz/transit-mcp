import type { TransitMode } from './modes';
import { z } from 'zod';
import { sha256 } from './shards';
import { parseServiceDate } from './time';
import type { ValidatorEvidence } from './schema';
export type { ArtifactManifestV2, ScheduleShard, DiscoveryIndex } from './schema';

const validatorReportSchema = z.object({
  summary: z.object({ validatorVersion: z.string().trim().min(1), validatedAt: z.string().min(1) }),
  notices: z.array(z.object({ code: z.string().trim().min(1), severity: z.enum(['ERROR', 'WARNING', 'INFO']), totalNotices: z.number().int().nonnegative() })),
});
const warningAllowlistSchema = z.object({
  coverageId: z.string(),
  warnings: z.array(z.object({ code: z.string().trim().min(1), reason: z.string().trim().min(1), expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
});

/** NoticeContainer.exportSystemErrors -> ValidationReportDeserializer.serialize.
 * The canonical empty report is exactly an object containing an empty notices
 * array. Unknown shapes and every nonempty list fail closed, regardless of count. */
export async function validateMobilityDataSystemErrors(systemErrorsJson: string): Promise<Pick<ValidatorEvidence, 'systemErrorsSha256' | 'systemErrorsFormat'>> {
  let errors;
  try { errors = z.object({ notices: z.array(z.unknown()) }).strict().parse(JSON.parse(systemErrorsJson)); }
  catch { throw new Error('Invalid MobilityData system errors report'); }
  if (errors.notices.length !== 0) throw new Error('MobilityData system errors block publication');
  return { systemErrorsSha256: await sha256(new TextEncoder().encode(systemErrorsJson)), systemErrorsFormat: 'MobilityData notices' };
}

/** Validate a caller-supplied canonical MobilityData report before any publication. */
export async function validateMobilityDataReport(
  reportJson: string, allowlistInput: unknown, coverageId: string, today: string,
): Promise<Omit<ValidatorEvidence, 'systemErrorsSha256' | 'systemErrorsFormat'>> {
  let report;
  try { report = validatorReportSchema.parse(JSON.parse(reportJson)); }
  catch { throw new Error('Invalid MobilityData validator report'); }
  if (!Number.isFinite(Date.parse(report.summary.validatedAt))) throw new Error('Invalid MobilityData validator report timestamp');
  const allowlist = warningAllowlistSchema.safeParse(allowlistInput);
  if (!allowlist.success || allowlist.data.coverageId !== coverageId) throw new Error('Invalid validator warning allowlist');
  parseServiceDate(today.replaceAll('-', ''));
  const entries = new Map<string, { reason: string; expires: string }>();
  for (const entry of allowlist.data.warnings) {
    parseServiceDate(entry.expires.replaceAll('-', ''));
    if (entry.expires <= today) throw new Error('Expired validator warning allowlist entry');
    if (entries.has(entry.code)) throw new Error('Duplicate validator warning allowlist entry');
    entries.set(entry.code, entry);
  }
  for (const notice of report.notices) {
    if (notice.totalNotices === 0) continue;
    if (notice.severity === 'ERROR') throw new Error('MobilityData validator error blocks publication');
    if (notice.severity === 'WARNING' && !entries.has(notice.code)) throw new Error(`Unallowlisted validator warning: ${notice.code}`);
  }
  return { name: 'MobilityData GTFS Validator', version: report.summary.validatorVersion,
    validatedAt: report.summary.validatedAt, reportSha256: await sha256(new TextEncoder().encode(reportJson)) };
}

export interface ArtifactStop {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  locationType: number;
  parentStationId?: string;
}

export interface ArtifactRoute {
  id: string;
  shortName: string;
  longName: string;
  mode: TransitMode;
  color?: string;
}

export interface StaticTransitArtifact {
  schemaVersion: 1;
  region: 'sfbay';
  sourceVersion: string;
  generatedAt: string;
  stops: ArtifactStop[];
  routes: ArtifactRoute[];
  stopRoutes: Record<string, string[]>;
  stopTimes?: ScheduledStopTime[];
  calendars?: Record<string, ServiceCalendar>;
}

export interface ScheduledStopTime {
  tripId: string; routeId: string; serviceId: string; stopId: string;
  arrivalSeconds: number; departureSeconds: number;
}

export interface ServiceCalendar {
  monday: boolean; tuesday: boolean; wednesday: boolean; thursday: boolean;
  friday: boolean; saturday: boolean; sunday: boolean;
  startDate: string; endDate: string; exceptions: Record<string, 1 | 2>;
}

type ArtifactInput = Omit<StaticTransitArtifact, 'schemaVersion'>;

function sortedRecord(values: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entries]) => [key, [...new Set(entries)].sort()]),
  );
}

export function createStaticArtifact(input: ArtifactInput): StaticTransitArtifact {
  return {
    schemaVersion: 1,
    region: input.region,
    sourceVersion: input.sourceVersion,
    generatedAt: input.generatedAt,
    stops: [...input.stops].sort((left, right) => left.id.localeCompare(right.id)),
    routes: [...input.routes].sort((left, right) => left.id.localeCompare(right.id)),
    stopRoutes: sortedRecord(input.stopRoutes),
    ...(input.stopTimes ? { stopTimes: [...input.stopTimes].sort((a, b) => a.stopId.localeCompare(b.stopId) || a.arrivalSeconds - b.arrivalSeconds || a.tripId.localeCompare(b.tripId)) } : {}),
    ...(input.calendars ? { calendars: Object.fromEntries(Object.entries(input.calendars).sort(([a], [b]) => a.localeCompare(b))) } : {}),
  };
}

export function searchStops(
  artifact: StaticTransitArtifact,
  query: string,
  limit = 20,
): ArtifactStop[] {
  const normalized = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  if (!normalized || limit <= 0) return [];

  return artifact.stops
    .filter(stop => (
      stop.id.toLocaleLowerCase('en-US').includes(normalized)
      || stop.name.toLocaleLowerCase('en-US').includes(normalized)
    ))
    .sort((left, right) => {
      const leftParentRank = left.locationType === 1 ? 0 : 1;
      const rightParentRank = right.locationType === 1 ? 0 : 1;
      return leftParentRank - rightParentRank
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}
