export const TASK_TWO_TOOL_NAMES = [
  'get_station_predictions',
  'get_bus_predictions',
  'search_stations',
  'get_stations_by_line',
  'get_all_stations',
  'get_station_transfers',
] as const;

export type TaskTwoToolName = (typeof TASK_TWO_TOOL_NAMES)[number];
export type TransitCity = 'dc' | 'nyc';

export type RailPrediction = {
  line: string;
  destination: string;
  minutesAway: number | null;
  arrivalTime: string | null;
  arrivalStatus: 'ARRIVING' | 'BOARDING' | 'DELAYED' | 'SCHEDULED';
  cars: string | null;
  direction: string | null;
  track: string | null;
};

export type BusPrediction = {
  route: string;
  direction: string;
  minutesAway: number;
  vehicleId: string | null;
  tripId: string | null;
};

export type StationAddress = {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
};

export type Station = {
  id: string;
  name: string;
  lines: string[];
  coordinates: { lat: number; lon: number };
  address: StationAddress | null;
};

export type StationTransfer = {
  toStationId: string;
  toStationName: string;
  walkTimeSeconds: number;
  walkTimeMinutes: number;
  transferType: 'platform' | 'nearby';
};

export type RailArrivalsModel = {
  kind: 'rail-arrivals';
  city: TransitCity;
  station: string;
  predictions: RailPrediction[];
};

export type BusArrivalsModel = {
  kind: 'bus-arrivals';
  city: 'dc';
  stopId: string;
  predictions: BusPrediction[];
};

export type StationSearchModel = {
  kind: 'station-search';
  city: TransitCity;
  query: string;
  stations: Station[];
};

export type LineStationsModel = {
  kind: 'line-stations';
  city: TransitCity;
  line: string;
  stations: Station[];
};

export type StationDirectoryModel = {
  kind: 'station-directory';
  city: TransitCity;
  totalStations: number;
  stations: Station[];
};

export type StationTransfersModel = {
  kind: 'station-transfers';
  city: 'nyc';
  stationId: string;
  stationName: string;
  totalTransfers: number;
  transfers: StationTransfer[];
};

export type TaskTwoRenderModel =
  | RailArrivalsModel
  | BusArrivalsModel
  | StationSearchModel
  | LineStationsModel
  | StationDirectoryModel
  | StationTransfersModel;

export type NarrowResult =
  | { ok: true; model: TaskTwoRenderModel }
  | { ok: false; viewLabel: string };

type UnknownRecord = Record<string, unknown>;

export function isTaskTwoToolName(toolName: string): toolName is TaskTwoToolName {
  return TASK_TWO_TOOL_NAMES.some(candidate => candidate === toolName);
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function displayString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
}

function city(value: unknown): TransitCity | undefined {
  return value === 'dc' || value === 'nyc' ? value : undefined;
}

function nullableDisplayString(value: unknown): string | null | undefined {
  return value === null ? null : displayString(value);
}

function displayStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings: string[] = [];
  for (const item of value) {
    const string = displayString(item);
    if (string === undefined) {
      return undefined;
    }
    strings.push(string);
  }
  return strings;
}

function parseArray<Item>(
  value: unknown,
  parseItem: (item: unknown) => Item | undefined,
): Item[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed: Item[] = [];
  for (const item of value) {
    const result = parseItem(item);
    if (result === undefined) {
      return undefined;
    }
    parsed.push(result);
  }
  return parsed;
}

function parseAddress(value: unknown): StationAddress | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const address: StationAddress = {};
  for (const key of ['street', 'city', 'state', 'zip'] as const) {
    const field = value[key];
    if (field === undefined) {
      continue;
    }
    const string = displayString(field);
    if (string === undefined) {
      return undefined;
    }
    address[key] = string;
  }
  return address;
}

function parseStation(value: unknown): Station | undefined {
  if (!isRecord(value) || !isRecord(value.coordinates)) {
    return undefined;
  }
  const id = displayString(value.id);
  const name = displayString(value.name);
  const lines = displayStringArray(value.lines);
  const lat = finiteNumber(value.coordinates.lat);
  const lon = finiteNumber(value.coordinates.lon);
  const address = parseAddress(value.address);
  if (
    id === undefined
    || name === undefined
    || lines === undefined
    || lat === undefined
    || lon === undefined
    || address === undefined
  ) {
    return undefined;
  }
  return { id, name, lines, coordinates: { lat, lon }, address };
}

function parseRailPrediction(value: unknown): RailPrediction | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const line = displayString(value.line);
  const destination = displayString(value.destination);
  const minutesAway = value.minutesAway === null
    ? null
    : nonNegativeInteger(value.minutesAway);
  const arrivalTime = nullableDisplayString(value.arrivalTime);
  const arrivalStatus = value.arrivalStatus;
  const cars = nullableDisplayString(value.cars);
  const direction = nullableDisplayString(value.direction);
  const track = nullableDisplayString(value.track);
  if (
    line === undefined
    || destination === undefined
    || minutesAway === undefined
    || arrivalTime === undefined
    || (arrivalStatus !== 'ARRIVING'
      && arrivalStatus !== 'BOARDING'
      && arrivalStatus !== 'DELAYED'
      && arrivalStatus !== 'SCHEDULED')
    || cars === undefined
    || direction === undefined
    || track === undefined
  ) {
    return undefined;
  }
  return {
    line,
    destination,
    minutesAway,
    arrivalTime,
    arrivalStatus,
    cars,
    direction,
    track,
  };
}

function parseBusPrediction(value: unknown): BusPrediction | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const route = displayString(value.route);
  const direction = displayString(value.direction);
  const minutesAway = nonNegativeInteger(value.minutesAway);
  const vehicleId = nullableDisplayString(value.vehicleId);
  const tripId = nullableDisplayString(value.tripId);
  if (
    route === undefined
    || direction === undefined
    || minutesAway === undefined
    || vehicleId === undefined
    || tripId === undefined
  ) {
    return undefined;
  }
  return { route, direction, minutesAway, vehicleId, tripId };
}

function parseTransfer(value: unknown): StationTransfer | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const toStationId = displayString(value.toStationId);
  const toStationName = displayString(value.toStationName);
  const walkTimeSeconds = nonNegativeInteger(value.walkTimeSeconds);
  const walkTimeMinutes = nonNegativeInteger(value.walkTimeMinutes);
  const transferType = value.transferType;
  if (
    toStationId === undefined
    || toStationName === undefined
    || walkTimeSeconds === undefined
    || walkTimeMinutes === undefined
    || (transferType !== 'platform' && transferType !== 'nearby')
  ) {
    return undefined;
  }
  return {
    toStationId,
    toStationName,
    walkTimeSeconds,
    walkTimeMinutes,
    transferType,
  };
}

function parseStations(value: unknown): Station[] | undefined {
  return parseArray(value, parseStation);
}

function malformed(viewLabel: string): NarrowResult {
  return { ok: false, viewLabel };
}

function narrowRailArrivals(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('train arrival');
  }
  const resultCity = city(value.city);
  const station = displayString(value.station);
  const predictions = parseArray(value.predictions, parseRailPrediction);
  return resultCity !== undefined && station !== undefined && predictions !== undefined
    ? { ok: true, model: { kind: 'rail-arrivals', city: resultCity, station, predictions } }
    : malformed('train arrival');
}

function narrowBusArrivals(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('bus arrival');
  }
  const stopId = displayString(value.stopId);
  const predictions = parseArray(value.predictions, parseBusPrediction);
  return value.city === 'dc' && stopId !== undefined && predictions !== undefined
    ? { ok: true, model: { kind: 'bus-arrivals', city: 'dc', stopId, predictions } }
    : malformed('bus arrival');
}

function narrowStationSearch(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('station search');
  }
  const resultCity = city(value.city);
  const query = displayString(value.query);
  const stations = parseStations(value.results);
  return resultCity !== undefined && query !== undefined && stations !== undefined
    ? { ok: true, model: { kind: 'station-search', city: resultCity, query, stations } }
    : malformed('station search');
}

function narrowLineStations(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('line station');
  }
  const resultCity = city(value.city);
  const line = displayString(value.line);
  const stations = parseStations(value.stations);
  return resultCity !== undefined && line !== undefined && stations !== undefined
    ? { ok: true, model: { kind: 'line-stations', city: resultCity, line, stations } }
    : malformed('line station');
}

function narrowStationDirectory(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('station directory');
  }
  const resultCity = city(value.city);
  const totalStations = nonNegativeInteger(value.totalStations);
  const stations = parseStations(value.stations);
  return resultCity !== undefined && totalStations !== undefined && stations !== undefined
    ? {
      ok: true,
      model: { kind: 'station-directory', city: resultCity, totalStations, stations },
    }
    : malformed('station directory');
}

function narrowStationTransfers(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('station transfer');
  }
  const stationId = displayString(value.stationId);
  const stationName = displayString(value.stationName);
  const totalTransfers = nonNegativeInteger(value.totalTransfers);
  const transfers = parseArray(value.transfers, parseTransfer);
  return value.city === 'nyc'
    && stationId !== undefined
    && stationName !== undefined
    && totalTransfers !== undefined
    && transfers !== undefined
    ? {
      ok: true,
      model: {
        kind: 'station-transfers',
        city: 'nyc',
        stationId,
        stationName,
        totalTransfers,
        transfers,
      },
    }
    : malformed('station transfer');
}

export function narrowToolResult(toolName: TaskTwoToolName, value: unknown): NarrowResult {
  switch (toolName) {
    case 'get_station_predictions':
      return narrowRailArrivals(value);
    case 'get_bus_predictions':
      return narrowBusArrivals(value);
    case 'search_stations':
      return narrowStationSearch(value);
    case 'get_stations_by_line':
      return narrowLineStations(value);
    case 'get_all_stations':
      return narrowStationDirectory(value);
    case 'get_station_transfers':
      return narrowStationTransfers(value);
  }
}
