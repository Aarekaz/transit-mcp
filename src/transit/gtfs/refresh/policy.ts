import { getCoverage, type CoverageManifest } from '../../core/coverage';

/** Where a coverage's schedule comes from and how it is refreshed at the edge.
 * Server-side only: names credential bindings, never values. */
export interface StaticSourcePolicy {
  coverageId: string;
  feedId: string;
  /** Official, credential-free archive URL (credentials travel as headers). */
  url: string;
  auth: { kind: 'header'; header: string; secretEnv: 'WMATA_API_KEY' } | { kind: 'none' };
  /** The publisher answers If-None-Match with 304, so a check costs no body. */
  conditional: boolean;
  checkIntervalSeconds: number;
  /** Published service dates after today, clipped to the feed's own end date. */
  windowDays: number;
  maxArchiveBytes: number;
  /** Optional publisher tables left out of every build (never edited), with the reason. */
  exclude?: { files: string[]; reason: string };
}

const policies: readonly StaticSourcePolicy[] = [
  { coverageId: 'dc', feedId: 'wmata', url: 'https://api.wmata.com/gtfs/rail-gtfs-static.zip',
    auth: { kind: 'header', header: 'api_key', secretEnv: 'WMATA_API_KEY' },
    // WMATA republishes a rolling window of about nine days and does not answer HEAD.
    conditional: false, checkIntervalSeconds: 6 * 3600, windowDays: 9, maxArchiveBytes: 32_000_000,
    exclude: { files: ['pathways.txt'], reason: 'Publisher pathways.txt fails MobilityData 8.0.1 with ERROR bidirectional_exit_gate and number_out_of_range (traversal_time 0); the optional table is excluded rather than repaired.' } },
  { coverageId: 'nyc', feedId: 'mta_subway', url: 'https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip',
    auth: { kind: 'none' },
    // MTA republishes planned service changes several times a day.
    conditional: true, checkIntervalSeconds: 5 * 60, windowDays: 7, maxArchiveBytes: 64_000_000 },
];

export function getStaticSources(): readonly (StaticSourcePolicy & { coverage: CoverageManifest })[] {
  return policies.flatMap(policy => { const coverage = getCoverage(policy.coverageId); return coverage ? [{ ...policy, coverage }] : []; });
}

export function getStaticSource(coverageId: string) {
  return getStaticSources().find(source => source.coverageId === coverageId);
}
