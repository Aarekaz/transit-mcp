import type { SupportedCity } from '../transit/base';
import type { CoverageBinding } from '../transit/core/coverage';

export type PublicCity = SupportedCity | 'sfbay';
export type RegionMode = 'off' | 'dark' | 'on' | 'suspended';
export type RealtimeFeedKind = 'trip_updates' | 'vehicle_positions' | 'service_alerts' | 'equipment_outages';

export interface RealtimeFeedSpec {
  kind: RealtimeFeedKind;
  /** Single upstream document. Use `parts` when one kind is published as several documents. */
  url?: URL;
  /** Every part is required: one snapshot is published only when all parts were read
   * in the same poll, because a missing part can hide service (e.g. a reroute onto a
   * line whose own feed loaded). */
  parts?: readonly { id: string; url: URL }[];
  /** Other kinds carried in the same documents, published from the same poll with no
   * extra upstream request (NYCT trip feeds carry each train's vehicle entity). */
  alsoPublishes?: readonly RealtimeFeedKind[];
  /** Agency JSON format of an `equipment_outages` feed (not GTFS-Realtime). */
  format?: 'wmata_elevator_incidents' | 'nyct_ene';
  /** Accept header when the document is not protobuf. */
  accept?: string;
  weight: number;
  minIntervalSeconds: number;
  maxBytes: number;
  timeoutMs: number;
}

export interface RegionManifest {
  id: Exclude<PublicCity, SupportedCity>;
  displayName: string;
  timezone: string;
  bounds: readonly [west: number, south: number, east: number, north: number];
  idStrategy: 'verbatim' | 'agency-prefix';
  secretEnv: CoverageBinding['secretEnv'];
  modeEnv: CoverageBinding['modeEnv'];
  realtime: {
    budget: {
      requestsPerHour: number;
      safetyFactor: number;
      reserveForStatic: number;
    };
    feeds: readonly RealtimeFeedSpec[];
  };
  static: {
    artifactPrefix: string;
    maxStaticAgeDays: number;
  };
  attribution: {
    text: string;
    url: string;
  };
}

/** Provider adapter for one coverage's realtime ingestion. Parsing differences live
 * here, never in the global tool contract. */
export interface RealtimeSourcePolicy {
  /** Durable Object name of the single coordinator owning this provider credential. */
  namespace: string;
  /** Static feed whose schedule this realtime describes. */
  feedId: string;
  /** `query_token` sends the credential as the `param` query parameter (default `api_key`). */
  auth: { kind: 'query_token'; secretEnv: 'SF511_API_KEY' | 'MTA_BUS_API_KEY'; param?: string } | { kind: 'header'; header: string; secretEnv: 'WMATA_API_KEY' } | { kind: 'none' };
  /** Further static feeds this one realtime source describes (MTA Bus Time covers six bus
   * timetables). Each trip is matched in the feed that publishes its route. */
  alsoFeedIds?: readonly string[];
  budget: { requestsPerHour: number; safetyFactor: number; reserveForStatic: number };
  /** `exact`: realtime trip_id equals the static trip_id.
   * `nyct_suffix`: NYCT realtime trip_id is the static trip_id after its first `_`;
   * the remaining stop list of a matched trip is its complete set of future calls.
   * `train_number`: the entity ID is the train number (static trip_short_name) and the
   * start date/time are its civil departure (Metro-North); trip_id is internal. */
  tripMatching: 'exact' | 'nyct_suffix' | 'train_number';
  /** Provider agency IDs used by alerts that name a static agency differently. */
  alertAgencyAliases?: Readonly<Record<string, string>>;
  /** Provider protobuf extensions to read: NYCT train IDs, or the MTA railroads' track. */
  extensions?: 'nyct' | 'mta_railroad';
  /** Seconds before now the match window starts, so a late or just-finished trip the
   * provider still reports is found in its timetable. Defaults to none. */
  matchLookbackSeconds?: number;
  /** `current_service_day`: the provider omits start_date on unambiguous trips (allowed by
   * GTFS-Realtime); resolve them only to the one scheduled instance in the match window. */
  undatedTrips?: 'current_service_day';
  /** Timetable span loaded to match trip updates; defaults to six hours. */
  matchWindowSeconds?: number;
}
