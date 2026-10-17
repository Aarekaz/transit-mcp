export type TransitMode = 'tram' | 'subway' | 'rail' | 'bus' | 'ferry' | 'cable_tram' | 'aerial' | 'funicular' | 'trolleybus' | 'monorail';

const STANDARD_MODES: Readonly<Record<number, TransitMode>> = {
  0: 'tram', 1: 'subway', 2: 'rail', 3: 'bus', 4: 'ferry', 5: 'cable_tram',
  6: 'aerial', 7: 'funicular', 11: 'trolleybus', 12: 'monorail',
};

export function routeTypeToMode(routeType: number): TransitMode {
  const standard = STANDARD_MODES[routeType];
  if (standard) return standard;
  if (routeType >= 100 && routeType <= 199) return 'rail';
  if (routeType >= 200 && routeType <= 299) return 'bus';
  if (routeType >= 400 && routeType <= 499) return 'subway';
  if (routeType >= 700 && routeType <= 799) return 'bus';
  if (routeType >= 900 && routeType <= 999) return 'tram';
  if (routeType >= 1000 && routeType <= 1099) return 'ferry';
  if (routeType >= 1200 && routeType <= 1299) return 'ferry';
  if (routeType >= 1300 && routeType <= 1399) return 'aerial';
  if (routeType >= 1400 && routeType <= 1499) return 'funicular';
  throw new Error(`Unsupported GTFS route_type: ${routeType}`);
}
