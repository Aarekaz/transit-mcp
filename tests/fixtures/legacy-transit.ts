import type { WMATAStation } from '../../src/types';

// Frozen, hand-checked provider-shaped replay excerpts, not live-feed claims.
// WMATA jStations/jPath/GetPrediction: https://developer.wmata.com/apis
// NYCT all-future-stop updates: https://www.mta.info/document/134521 (pp. 4, 9).
export const REPLAY_NOW = '2026-10-18T16:00:00.000Z';
export const wmataStations: WMATAStation[] = [
  { Code: 'A01', Name: 'Metro Center', Lat: 38.898303, Lon: -77.028099, LineCode1: 'RD', LineCode2: null, LineCode3: null, LineCode4: null, StationTogether1: 'C01', StationTogether2: '', Address: { Street: '607 13th St NW', City: 'Washington', State: 'DC', Zip: '20005' } },
  { Code: 'C01', Name: 'Metro Center', Lat: 38.898303, Lon: -77.028099, LineCode1: 'BL', LineCode2: 'OR', LineCode3: 'SV', LineCode4: null, StationTogether1: 'A01', StationTogether2: '', Address: { Street: '607 13th St NW', City: 'Washington', State: 'DC', Zip: '20005' } },
  { Code: 'A02', Name: 'Farragut North', Lat: 38.903192, Lon: -77.039766, LineCode1: 'RD', LineCode2: null, LineCode3: null, LineCode4: null, StationTogether1: '', StationTogether2: '', Address: { Street: '1001 Connecticut Ave NW', City: 'Washington', State: 'DC', Zip: '20036' } },
  { Code: 'A03', Name: 'Dupont Circle', Lat: 38.909499, Lon: -77.04362, LineCode1: 'RD', LineCode2: null, LineCode3: null, LineCode4: null, StationTogether1: '', StationTogether2: '', Address: { Street: '1525 20th St NW', City: 'Washington', State: 'DC', Zip: '20036' } },
];

export const wmataPredictions = { Trains: [
  { Car: '8', Destination: 'Shady Gr', DestinationCode: 'A15', DestinationName: 'Shady Grove', Group: '1', Line: 'RD', LocationCode: 'A03', LocationName: 'Dupont Circle', Min: '2' },
  { Car: '6', Destination: 'Glenmont', DestinationCode: 'B11', DestinationName: 'Glenmont', Group: '2', Line: 'RD', LocationCode: 'A03', LocationName: 'Dupont Circle', Min: '5' },
] };

// jPath excerpt deliberately arrives out of array order; SeqNum is authoritative.
export const wmataPath = { Path: [
  { StationCode: 'A01', StationName: 'Metro Center', SeqNum: 15, DistanceToPrev: 1870, LineCode: 'RD' },
  { StationCode: 'A03', StationName: 'Dupont Circle', SeqNum: 13, DistanceToPrev: 1980, LineCode: 'RD' },
  { StationCode: 'A02', StationName: 'Farragut North', SeqNum: 14, DistanceToPrev: 2790, LineCode: 'RD' },
] };

// Complete station-code pattern from Shady Grove to Glenmont. Fields not used
// by ordering retain the provider shape; coordinate assertions use the excerpt.
const redLineStops = [
  ['A15', 'Shady Grove'], ['A14', 'Rockville'], ['A13', 'Twinbrook'],
  ['A12', 'North Bethesda'], ['A11', 'Grosvenor-Strathmore'], ['A10', 'Medical Center'],
  ['A09', 'Bethesda'], ['A08', 'Friendship Heights'], ['A07', 'Tenleytown-AU'],
  ['A06', 'Van Ness-UDC'], ['A05', 'Cleveland Park'], ['A04', 'Woodley Park-Zoo/Adams Morgan'],
  ['A03', 'Dupont Circle'], ['A02', 'Farragut North'], ['A01', 'Metro Center'],
  ['B01', 'Gallery Pl-Chinatown'], ['B02', 'Judiciary Square'], ['B03', 'Union Station'], ['B35', 'NoMa-Gallaudet U'],
  ['B04', 'Rhode Island Ave-Brentwood'], ['B05', 'Brookland-CUA'], ['B06', 'Fort Totten'],
  ['B07', 'Takoma'], ['B08', 'Silver Spring'], ['B09', 'Forest Glen'], ['B10', 'Wheaton'], ['B11', 'Glenmont'],
] as const;
export const redLinePath = { Path: redLineStops.map(([StationCode, StationName], index) => ({ StationCode, StationName, SeqNum: index + 1, LineCode: 'RD', DistanceToPrev: 0 })).reverse() };
export const redLineStations: WMATAStation[] = redLineStops.map(([Code, Name]) =>
  wmataStations.find(station => station.Code === Code) ?? {
    Code, Name, Lat: 0, Lon: 0, LineCode1: 'RD', LineCode2: null, LineCode3: null, LineCode4: null,
    StationTogether1: '', StationTogether2: '', Address: { Street: '', City: '', State: '', Zip: '' },
  });

// Remaining calls near South Ferry. Actual departure removes Chambers St from
// the first trip. The past-due trip still lists it and must remain uncertain.
export const nycFeed = {
  header: { gtfsRealtimeVersion: '1.0', timestamp: 1792339200 },
  entity: [
    { id: 'departed', tripUpdate: { trip: { tripId: '070000_1..S03R', routeId: '1', startDate: '20261018' }, stopTimeUpdate: [
      { stopId: '138S', arrival: { time: 1792339300 } },
      { stopId: '139S', arrival: { time: 1792339420 } },
      { stopId: '142S', arrival: { time: 1792339540 } },
    ] } },
    { id: 'past-due', tripUpdate: { trip: { tripId: '070100_1..S03R', routeId: '1', startDate: '20261018' }, stopTimeUpdate: [
      { stopId: '137S', arrival: { time: 1792339170 }, departure: { time: 1792339180 } },
      { stopId: '138S', arrival: { time: 1792339300 } },
      { stopId: '139S', arrival: { time: 1792339420 } },
      { stopId: '142S', arrival: { time: 1792339540 } },
    ] } },
    { id: 'future', tripUpdate: { trip: { tripId: '070500_1..S03R', routeId: '1', startDate: '20261018' }, stopTimeUpdate: [
      { stopId: '137S', arrival: { time: 1792339500 }, departure: { time: 1792339510 } },
      { stopId: '138S', arrival: { time: 1792339620 } },
      { stopId: '139S', arrival: { time: 1792339740 } },
      { stopId: '142S', arrival: { time: 1792339860 } },
    ] } },
    { id: 'at-platform', tripUpdate: { trip: { tripId: '070200_1..S03R', routeId: '1', startDate: '20261018' }, stopTimeUpdate: [
      { stopId: '137S', arrival: { time: 1792339190 }, departure: { time: 1792339230 } },
      { stopId: '138S', arrival: { time: 1792339360 } },
      { stopId: '139S', arrival: { time: 1792339480 } },
      { stopId: '142S', arrival: { time: 1792339600 } },
    ] } },
  ],
};

// Reduced replay of an F train rerouted via the A/C/E 8 Avenue platform.
// A27's static line membership is A/C/E; the realtime stop call is authoritative.
export const nycRerouteFeed = {
  header: { gtfsRealtimeVersion: '1.0', timestamp: 1792339200 },
  entity: [{ id: 'F-rerouted-via-8-av', tripUpdate: {
    trip: { tripId: '070500_F..S69R', routeId: 'F', startDate: '20261018' },
    stopTimeUpdate: [
      { stopId: 'A27S', arrival: { time: 1792339500 } },
      { stopId: 'A28S', arrival: { time: 1792339620 } },
      { stopId: 'D43S', arrival: { time: 1792343100 } },
    ],
  } }],
};

export const nycAlertFeed = { entity: [{
  id: 'alert-no-updated-at', alert: {
    informed_entity: [{ route_id: '1' }],
    header_text: { translation: [{ language: 'en', text: 'Southbound 1 trains are delayed.' }] },
    'transit_realtime.mercury_alert': { alert_type: 'Delays' },
  },
}] };
