export const SUPPORTED_TOOL_NAMES = [
  'get_station_predictions',
  'search_stations',
  'get_stations_by_line',
  'get_all_stations',
  'get_station_transfers',
  'get_incidents',
  'get_elevator_incidents',
  'get_bus_predictions',
  'get_bus_routes',
  'get_bus_stops',
  'get_bus_positions',
  'get_train_positions',
  'get_route_info',
] as const;

export type SupportedToolName = (typeof SUPPORTED_TOOL_NAMES)[number];
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

export type ServiceIncident = {
  id: string;
  description: string;
  linesAffected: string[];
  severity: string;
  type: string;
  lastUpdated: string;
};

export type ElevatorIncident = {
  id: string;
  description: string;
  unitName: string;
  unitType: string;
  stationCode: string;
  stationName: string;
  locationDescription: string;
  symptomDescription: string;
  outOfServiceAt: string;
  estimatedReturnToService: string | null;
  lastUpdated: string;
};

export type BusRoute = {
  id: string;
  name: string;
  description: string | null;
};

export type BusStop = {
  id: string;
  name: string;
  coordinates: { lat: number; lon: number };
  routes: string[];
};

export type SearchLocation = {
  lat: number;
  lon: number;
  radiusMeters: number | null;
};

export type BusPosition = {
  vehicleId: string;
  route: string;
  direction: string;
  coordinates: { lat: number; lon: number };
  headsign: string | null;
  deviation: number | null;
  lastUpdated: string;
};

export type TrainPosition = {
  trainId: string;
  trainNumber: string | null;
  line: string | null;
  destination: string | null;
  carCount: number | null;
  direction: 'Northbound/Eastbound' | 'Southbound/Westbound';
  circuitId: number | null;
  secondsAtLocation: number | null;
  serviceType: string | null;
};

export type ServiceIncidentsModel = {
  kind: 'service-incidents';
  city: TransitCity;
  incidents: ServiceIncident[];
};

export type ElevatorIncidentsModel = {
  kind: 'elevator-incidents';
  city: 'dc';
  incidents: ElevatorIncident[];
};

export type BusRoutesModel = {
  kind: 'bus-routes';
  city: 'dc';
  totalRoutes: number;
  routes: BusRoute[];
};

export type BusStopsModel = {
  kind: 'bus-stops';
  city: 'dc';
  totalStops: number;
  searchLocation: SearchLocation | null;
  stops: BusStop[];
};

export type BusPositionsModel = {
  kind: 'bus-positions';
  city: 'dc';
  routeFilter: string | null;
  totalBuses: number;
  buses: BusPosition[];
};

export type TrainPositionsModel = {
  kind: 'train-positions';
  city: 'dc';
  totalTrains: number;
  trains: TrainPosition[];
};

export type RouteDetailModel = {
  kind: 'route-detail';
  city: 'nyc';
  routeId: string;
  shortName: string;
  longName: string;
  description: string;
};

export type TransitRenderModel =
  | RailArrivalsModel
  | BusArrivalsModel
  | StationSearchModel
  | LineStationsModel
  | StationDirectoryModel
  | StationTransfersModel
  | ServiceIncidentsModel
  | ElevatorIncidentsModel
  | BusRoutesModel
  | BusStopsModel
  | BusPositionsModel
  | TrainPositionsModel
  | RouteDetailModel;

export type NarrowResult =
  | { ok: true; model: TransitRenderModel }
  | { ok: false; viewLabel: string };

type UnknownRecord = Record<string, unknown>;

export function isSupportedToolName(toolName: string): toolName is SupportedToolName {
  return SUPPORTED_TOOL_NAMES.some(candidate => candidate === toolName);
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

function nullableFiniteNumber(value: unknown): number | null | undefined {
  return value === null ? null : finiteNumber(value);
}

function nullableNonNegativeInteger(value: unknown): number | null | undefined {
  return value === null ? null : nonNegativeInteger(value);
}

function city(value: unknown): TransitCity | undefined {
  return value === 'dc' || value === 'nyc' ? value : undefined;
}

function nullableDisplayString(value: unknown): string | null | undefined {
  return value === null ? null : displayString(value);
}

function timestamp(value: unknown): string | undefined {
  const text = displayString(value);
  return text !== undefined && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  return value === null ? null : timestamp(value);
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

function parseServiceIncident(value: unknown): ServiceIncident | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = displayString(value.id);
  const description = displayString(value.description);
  const linesAffected = displayStringArray(value.linesAffected);
  const severity = displayString(value.severity);
  const type = displayString(value.type);
  const lastUpdated = timestamp(value.lastUpdated);
  if (
    id === undefined
    || description === undefined
    || linesAffected === undefined
    || severity === undefined
    || type === undefined
    || lastUpdated === undefined
  ) {
    return undefined;
  }
  return { id, description, linesAffected, severity, type, lastUpdated };
}

function parseElevatorIncident(value: unknown): ElevatorIncident | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = displayString(value.id);
  const description = displayString(value.description);
  const unitName = displayString(value.unitName);
  const unitType = displayString(value.unitType);
  const stationCode = displayString(value.stationCode);
  const stationName = displayString(value.stationName);
  const locationDescription = displayString(value.locationDescription);
  const symptomDescription = displayString(value.symptomDescription);
  const outOfServiceAt = timestamp(value.outOfServiceAt);
  const estimatedReturnToService = nullableTimestamp(value.estimatedReturnToService);
  const lastUpdated = timestamp(value.lastUpdated);
  if (
    id === undefined
    || description === undefined
    || unitName === undefined
    || unitType === undefined
    || stationCode === undefined
    || stationName === undefined
    || locationDescription === undefined
    || symptomDescription === undefined
    || outOfServiceAt === undefined
    || estimatedReturnToService === undefined
    || lastUpdated === undefined
  ) {
    return undefined;
  }
  return {
    id,
    description,
    unitName,
    unitType,
    stationCode,
    stationName,
    locationDescription,
    symptomDescription,
    outOfServiceAt,
    estimatedReturnToService,
    lastUpdated,
  };
}

function parseBusRoute(value: unknown): BusRoute | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = displayString(value.id);
  const name = displayString(value.name);
  const description = nullableDisplayString(value.description);
  return id !== undefined && name !== undefined && description !== undefined
    ? { id, name, description }
    : undefined;
}

function parseCoordinates(value: unknown): { lat: number; lon: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const lat = finiteNumber(value.lat);
  const lon = finiteNumber(value.lon);
  return lat !== undefined && lon !== undefined ? { lat, lon } : undefined;
}

function parseBusStop(value: unknown): BusStop | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = displayString(value.id);
  const name = displayString(value.name);
  const coordinates = parseCoordinates(value.coordinates);
  const routes = displayStringArray(value.routes);
  return id !== undefined && name !== undefined && coordinates !== undefined && routes !== undefined
    ? { id, name, coordinates, routes }
    : undefined;
}

function parseSearchLocation(value: unknown): SearchLocation | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const lat = finiteNumber(value.lat);
  const lon = finiteNumber(value.lon);
  const radiusMeters = nullableFiniteNumber(value.radiusMeters);
  return lat !== undefined && lon !== undefined && radiusMeters !== undefined
    ? { lat, lon, radiusMeters }
    : undefined;
}

function parseBusPosition(value: unknown): BusPosition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const vehicleId = displayString(value.vehicleId);
  const route = displayString(value.route);
  const direction = displayString(value.direction);
  const coordinates = parseCoordinates(value.coordinates);
  const headsign = nullableDisplayString(value.headsign);
  const deviation = nullableFiniteNumber(value.deviation);
  const lastUpdated = timestamp(value.lastUpdated);
  if (
    vehicleId === undefined
    || route === undefined
    || direction === undefined
    || coordinates === undefined
    || headsign === undefined
    || deviation === undefined
    || lastUpdated === undefined
  ) {
    return undefined;
  }
  return { vehicleId, route, direction, coordinates, headsign, deviation, lastUpdated };
}

function parseTrainPosition(value: unknown): TrainPosition | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const trainId = displayString(value.trainId);
  const trainNumber = nullableDisplayString(value.trainNumber);
  const line = nullableDisplayString(value.line);
  const destination = nullableDisplayString(value.destination);
  const carCount = nullableNonNegativeInteger(value.carCount);
  const direction = value.direction;
  const circuitId = nullableNonNegativeInteger(value.circuitId);
  const secondsAtLocation = nullableNonNegativeInteger(value.secondsAtLocation);
  const serviceType = nullableDisplayString(value.serviceType);
  if (
    trainId === undefined
    || trainNumber === undefined
    || line === undefined
    || destination === undefined
    || carCount === undefined
    || (direction !== 'Northbound/Eastbound' && direction !== 'Southbound/Westbound')
    || circuitId === undefined
    || secondsAtLocation === undefined
    || serviceType === undefined
  ) {
    return undefined;
  }
  return {
    trainId,
    trainNumber,
    line,
    destination,
    carCount,
    direction,
    circuitId,
    secondsAtLocation,
    serviceType,
  };
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

function narrowServiceIncidents(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('service incident');
  }
  const resultCity = city(value.city);
  const incidents = parseArray(value.incidents, parseServiceIncident);
  return resultCity !== undefined && incidents !== undefined
    ? { ok: true, model: { kind: 'service-incidents', city: resultCity, incidents } }
    : malformed('service incident');
}

function narrowElevatorIncidents(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('elevator incident');
  }
  const incidents = parseArray(value.elevatorIncidents, parseElevatorIncident);
  return value.city === 'dc' && incidents !== undefined
    ? { ok: true, model: { kind: 'elevator-incidents', city: 'dc', incidents } }
    : malformed('elevator incident');
}

function narrowBusRoutes(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('bus route');
  }
  const totalRoutes = nonNegativeInteger(value.totalRoutes);
  const routes = parseArray(value.routes, parseBusRoute);
  return value.city === 'dc' && totalRoutes !== undefined && routes !== undefined
    ? { ok: true, model: { kind: 'bus-routes', city: 'dc', totalRoutes, routes } }
    : malformed('bus route');
}

function narrowBusStops(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('bus stop');
  }
  const totalStops = nonNegativeInteger(value.totalStops);
  const searchLocation = parseSearchLocation(value.searchLocation);
  const stops = parseArray(value.stops, parseBusStop);
  return value.city === 'dc'
    && totalStops !== undefined
    && searchLocation !== undefined
    && stops !== undefined
    ? { ok: true, model: { kind: 'bus-stops', city: 'dc', totalStops, searchLocation, stops } }
    : malformed('bus stop');
}

function narrowBusPositions(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('bus position');
  }
  const routeFilter = nullableDisplayString(value.routeFilter);
  const totalBuses = nonNegativeInteger(value.totalBuses);
  const buses = parseArray(value.buses, parseBusPosition);
  return value.city === 'dc'
    && routeFilter !== undefined
    && totalBuses !== undefined
    && buses !== undefined
    ? { ok: true, model: { kind: 'bus-positions', city: 'dc', routeFilter, totalBuses, buses } }
    : malformed('bus position');
}

function narrowTrainPositions(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('train position');
  }
  const totalTrains = nonNegativeInteger(value.totalTrains);
  const trains = parseArray(value.trains, parseTrainPosition);
  return value.city === 'dc' && totalTrains !== undefined && trains !== undefined
    ? { ok: true, model: { kind: 'train-positions', city: 'dc', totalTrains, trains } }
    : malformed('train position');
}

function narrowRouteDetail(value: unknown): NarrowResult {
  if (!isRecord(value)) {
    return malformed('route detail');
  }
  const routeId = displayString(value.routeId);
  const shortName = displayString(value.shortName);
  const longName = displayString(value.longName);
  const description = displayString(value.description);
  return value.city === 'nyc'
    && routeId !== undefined
    && shortName !== undefined
    && longName !== undefined
    && description !== undefined
    ? {
      ok: true,
      model: { kind: 'route-detail', city: 'nyc', routeId, shortName, longName, description },
    }
    : malformed('route detail');
}

export function narrowToolResult(toolName: SupportedToolName, value: unknown): NarrowResult {
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
    case 'get_incidents':
      return narrowServiceIncidents(value);
    case 'get_elevator_incidents':
      return narrowElevatorIncidents(value);
    case 'get_bus_routes':
      return narrowBusRoutes(value);
    case 'get_bus_stops':
      return narrowBusStops(value);
    case 'get_bus_positions':
      return narrowBusPositions(value);
    case 'get_train_positions':
      return narrowTrainPositions(value);
    case 'get_route_info':
      return narrowRouteDetail(value);
  }
}
