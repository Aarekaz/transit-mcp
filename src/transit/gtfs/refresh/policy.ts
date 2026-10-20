import { getCoverage, type CoverageManifest } from '../../core/coverage';
import { NYC_BUS_ARCHIVES, NYC_BUS_FEEDS } from '../../../regions/nyc';

/** Where a coverage feed's schedule comes from and how it is refreshed at the edge.
 * Server-side only: names credential bindings, never values. A coverage's first policy is
 * its primary feed; each feed refreshes on its own and replaces only its own part of the
 * coverage's manifest. */
export interface StaticSourcePolicy {
  coverageId: string;
  feedId: string;
  /** Official, credential-free archive URL (credentials travel as headers). */
  url: string;
  auth: { kind: 'header'; header: string; secretEnv: 'WMATA_API_KEY' | 'MTA_BUS_API_KEY' } | { kind: 'none' };
  /** The publisher answers If-None-Match with 304, so a check costs no body. */
  conditional: boolean;
  checkIntervalSeconds: number;
  /** Published service dates after today, clipped to the feed's own end date. */
  windowDays: number;
  maxArchiveBytes: number;
  /** Time band of each shard; three hours unless the feed is dense (buses). */
  bandSeconds?: number;
  /** Dense feeds (a bus day is ~600,000 stop times scattered through a 177 MB table) split
   * the stored stop_times by band in their own steps, so no step holds a day at once. */
  splitByBand?: true;
  /** Optional publisher tables left out of every build (never edited), with the reason. */
  exclude?: { files: string[]; reason: string };
}

const policies: readonly StaticSourcePolicy[] = [
  { coverageId: 'dc', feedId: 'wmata', url: 'https://api.wmata.com/gtfs/rail-gtfs-static.zip',
    auth: { kind: 'header', header: 'api_key', secretEnv: 'WMATA_API_KEY' },
    // WMATA republishes a rolling window of about nine days and does not answer HEAD.
    conditional: false, checkIntervalSeconds: 6 * 3600, windowDays: 9, maxArchiveBytes: 32_000_000,
    exclude: { files: ['pathways.txt'], reason: 'Publisher pathways.txt fails MobilityData 8.0.1 with ERROR bidirectional_exit_gate and number_out_of_range (traversal_time 0); the optional table is excluded rather than repaired.' } },
  // The bus archive answers If-None-Match. An hour of peak Metrobus service is about 3 MB.
  { coverageId: 'dc', feedId: 'wmata_bus', url: 'https://api.wmata.com/gtfs/bus-gtfs-static.zip',
    auth: { kind: 'header', header: 'api_key', secretEnv: 'WMATA_API_KEY' },
    conditional: true, checkIntervalSeconds: 6 * 3600, windowDays: 7, maxArchiveBytes: 64_000_000, bandSeconds: 3600, splitByBand: true },
  { coverageId: 'nyc', feedId: 'mta_subway', url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip',
    auth: { kind: 'none' },
    // MTA republishes planned service changes several times a day.
    conditional: true, checkIntervalSeconds: 5 * 60, windowDays: 7, maxArchiveBytes: 64_000_000 },
  { coverageId: 'nyc', feedId: 'lirr', url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip',
    auth: { kind: 'none' }, conditional: true, checkIntervalSeconds: 30 * 60, windowDays: 7, maxArchiveBytes: 32_000_000 },
  { coverageId: 'nyc', feedId: 'mnr', url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip',
    auth: { kind: 'none' }, conditional: true, checkIntervalSeconds: 30 * 60, windowDays: 7, maxArchiveBytes: 32_000_000 },
  // Bus timetables are public; only Bus Time realtime needs MTA_BUS_API_KEY.
  ...NYC_BUS_FEEDS.map(feedId => ({ coverageId: 'nyc', feedId, url: `https://rrgtfsfeeds.s3.amazonaws.com/${NYC_BUS_ARCHIVES[feedId]}.zip`,
    auth: { kind: 'none' as const }, conditional: true, checkIntervalSeconds: 60 * 60, windowDays: 7, maxArchiveBytes: 64_000_000, bandSeconds: 3600, splitByBand: true as const })),
];

export function getStaticSources(): readonly (StaticSourcePolicy & { coverage: CoverageManifest })[] {
  return policies.flatMap(policy => { const coverage = getCoverage(policy.coverageId); return coverage ? [{ ...policy, coverage }] : []; });
}

/** One feed's source; the coverage's primary feed when `feedId` is omitted. */
export function getStaticSource(coverageId: string, feedId?: string) {
  return getStaticSources().find(source => source.coverageId === coverageId && (feedId === undefined || source.feedId === feedId));
}

/** The coverage's first configured feed keeps the storage keys it had before coverages
 * held several feeds. */
export function isPrimaryFeed(coverageId: string, feedId: string): boolean {
  return getStaticSource(coverageId)?.feedId === feedId;
}
