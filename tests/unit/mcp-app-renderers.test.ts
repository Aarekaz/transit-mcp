// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { EXPECTED_TOOL_CONTRACTS, EXPECTED_TOOL_NAMES } from '../fixtures/mcp-contracts';
import { SUPPORTED_TOOL_NAMES as SUPPORTED_RENDERER_NAMES } from '../../apps/transit-board/src/model';
import { renderToolResult } from '../../apps/transit-board/src/render';

const directoryResult = {
  city: 'nyc',
  totalStations: 2,
  stations: [
    EXPECTED_TOOL_CONTRACTS.get_all_stations.structuredContent.stations[0],
    {
      id: 'A41',
      name: 'Jay St - MetroTech',
      lines: ['A', 'C', 'F'],
      coordinates: { lat: 40.692338, lon: -73.987342 },
      address: null,
    },
  ],
} as const;

const mountResult = (toolName: string, structuredContent: unknown): HTMLElement => {
  const container = document.createElement('main');
  document.body.append(container);
  renderToolResult(container, toolName, structuredContent);
  return container;
};

const queryRequired = <ElementType extends Element>(
  container: ParentNode,
  selector: string,
): ElementType => {
  const element = container.querySelector<ElementType>(selector);
  if (!element) {
    throw new Error(`Missing required test element: ${selector}`);
  }
  return element;
};

const deepFreeze = <Value>(value: Value): Readonly<Value> => {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
};

afterEach(() => {
  document.body.replaceChildren();
});

describe('Transit Board arrival renderers', () => {
  it('renders the representative rail wire result as an operational arrivals board', () => {
    const result = EXPECTED_TOOL_CONTRACTS.get_station_predictions.structuredContent;
    const container = mountResult('get_station_predictions', result);

    expect(queryRequired(container, 'section[data-view="rail-arrivals"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('A01 train arrivals');
    expect(container.textContent).toContain('Glenmont');
    expect(container.textContent).toContain('5 min');
    expect(container.textContent).toContain('Track 2');
    expect(container.textContent).toContain('8 cars');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).not.toContain(JSON.stringify(result));
  });

  it('renders bus predictions with a labeled route filter that changes only the visible rows', () => {
    const representative = EXPECTED_TOOL_CONTRACTS.get_bus_predictions.structuredContent;
    const result = {
      ...representative,
      predictions: [
        representative.predictions[0],
        {
          route: '30S',
          direction: 'SOUTHBOUND',
          minutesAway: 11,
          vehicleId: null,
          tripId: null,
        },
      ],
    };
    const container = mountResult('get_bus_predictions', result);

    expect(queryRequired(container, 'section[data-view="bus-arrivals"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('Stop 1001195 bus arrivals');
    const filter = queryRequired<HTMLSelectElement>(container, 'select[name="route-filter"]');
    expect(filter.labels?.[0]?.textContent).toContain('Route');
    expect(filter.tabIndex).toBeGreaterThanOrEqual(0);
    expect(container.querySelectorAll('[data-arrival-row]')).toHaveLength(2);

    filter.value = '30S';
    filter.dispatchEvent(new Event('change', { bubbles: true }));

    const rows = container.querySelectorAll('[data-arrival-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('SOUTHBOUND');
    expect(rows[0]?.textContent).not.toContain('30N');
  });

  it('renders a useful empty arrivals state', () => {
    const container = mountResult('get_station_predictions', {
      city: 'dc',
      station: 'A01',
      predictions: [],
    });

    expect(queryRequired(container, '[data-empty-state]').textContent).toContain(
      'No train arrivals are available',
    );
  });

  it('renders the distinct bus empty state', () => {
    const container = mountResult('get_bus_predictions', {
      city: 'dc',
      stopId: '1001195',
      predictions: [],
    });

    expect(queryRequired(container, '[data-empty-state]').textContent).toContain(
      'No bus arrivals are available',
    );
  });
});

describe('Transit Board station and network renderers', () => {
  it('filters representative search results and exposes selectable station details', () => {
    const result = EXPECTED_TOOL_CONTRACTS.search_stations.structuredContent;
    const container = mountResult('search_stations', result);

    expect(queryRequired(container, 'section[data-view="station-search"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('Stations matching “Times Square”');
    const filter = queryRequired<HTMLInputElement>(container, 'input[type="search"]');
    expect(filter.labels?.[0]?.textContent).toContain('Filter stations');
    expect(filter.tabIndex).toBeGreaterThanOrEqual(0);

    const station = queryRequired<HTMLButtonElement>(container, '[data-station-row] button');
    expect(station.type).toBe('button');
    station.click();

    const detail = queryRequired(container, '[data-station-detail]');
    expect(detail.textContent).toContain('Broadway & 42nd St');
    expect(detail.textContent).toContain('40.755983');

    filter.value = 'not present';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(queryRequired(container, '[data-empty-state]').textContent).toContain(
      'No stations match this filter',
    );
  });

  it('renders line stations as an ordered, selectable network view', () => {
    const result = EXPECTED_TOOL_CONTRACTS.get_stations_by_line.structuredContent;
    const container = mountResult('get_stations_by_line', result);

    expect(queryRequired(container, 'section[data-view="line-stations"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('Line 1 stations');
    expect(container.querySelector('ol[data-station-list]')).toBeTruthy();
    const station = queryRequired<HTMLButtonElement>(container, '[data-station-row] button');
    station.click();
    expect(queryRequired(container, '[data-station-detail]').textContent).toContain(
      'Times Square - 42 St',
    );
  });

  it('groups the all-stations directory by line and keeps filter and line focus accessible', () => {
    const container = mountResult('get_all_stations', directoryResult);

    expect(queryRequired(container, 'section[data-view="station-directory"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('NYC station directory');
    const filter = queryRequired<HTMLInputElement>(container, 'input[type="search"]');
    expect(filter.getAttribute('aria-label')).toBe('Filter station directory');
    const lineFocus = [...container.querySelectorAll<HTMLButtonElement>('[data-line-focus]')]
      .find(button => button.textContent === 'A');
    if (!lineFocus) {
      throw new Error('Missing line A focus control');
    }
    expect(lineFocus.getAttribute('aria-pressed')).toBe('false');
    lineFocus.click();
    expect(lineFocus.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('[data-station-row]')).toHaveLength(1);
    expect(container.textContent).toContain('Jay St - MetroTech');
    expect(container.textContent).not.toContain('Times Square - 42 St');
  });

  it('keeps one pressed station and matching detail when selection crosses line groups', () => {
    const container = mountResult('get_all_stations', directoryResult);
    const stationControls = [...container.querySelectorAll<HTMLButtonElement>(
      '[data-station-row] button',
    )];
    const timesSquare = stationControls.find(control => (
      control.textContent?.includes('Times Square - 42 St')
    ));
    const jayStreet = stationControls.find(control => (
      control.textContent?.includes('Jay St - MetroTech')
    ));
    if (!timesSquare || !jayStreet) {
      throw new Error('Missing cross-group station controls');
    }

    timesSquare.click();
    jayStreet.click();

    const pressed = container.querySelectorAll(
      '[data-station-row] button[aria-pressed="true"]',
    );
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toBe(jayStreet);
    expect(queryRequired(container, '[data-station-detail]').textContent).toContain(
      'Jay St - MetroTech',
    );
  });

  it('renders the transfer source and keyboard-reachable destination focus', () => {
    const result = EXPECTED_TOOL_CONTRACTS.get_station_transfers.structuredContent;
    const container = mountResult('get_station_transfers', result);

    expect(queryRequired(container, 'section[data-view="station-transfers"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('Transfers from Times Square - 42 St');
    const destination = queryRequired<HTMLButtonElement>(container, '[data-transfer-row] button');
    expect(destination.type).toBe('button');
    expect(destination.tabIndex).toBeGreaterThanOrEqual(0);
    destination.click();
    expect(destination.getAttribute('aria-pressed')).toBe('true');
    expect(queryRequired(container, '[data-transfer-detail]').textContent).toContain(
      '2 min walk',
    );
  });

  it.each([
    {
      toolName: 'search_stations',
      result: { city: 'nyc', query: 'Ghost', results: [] },
      message: 'No stations were found for this search',
    },
    {
      toolName: 'get_stations_by_line',
      result: { city: 'nyc', line: 'A', stations: [] },
      message: 'No stations are listed for line A',
    },
    {
      toolName: 'get_all_stations',
      result: { city: 'nyc', totalStations: 0, stations: [] },
      message: 'No stations are available in this directory',
    },
    {
      toolName: 'get_station_transfers',
      result: {
        city: 'nyc',
        stationId: '127',
        stationName: 'Times Square - 42 St',
        totalTransfers: 0,
        transfers: [],
      },
      message: 'No transfer connections are listed for this station',
    },
  ])('renders the $toolName empty state', ({ toolName, result, message }) => {
    const container = mountResult(toolName, result);
    expect(queryRequired(container, '[data-empty-state]').textContent).toContain(message);
  });
});

describe('Transit Board service renderers', () => {
  it('renders service incidents with client-only severity and line filters', () => {
    const representative = EXPECTED_TOOL_CONTRACTS.get_incidents.structuredContent;
    const result = {
      ...representative,
      incidents: [
        representative.incidents[0],
        {
          id: 'INC-43',
          description: 'Blue Line single tracking',
          linesAffected: ['BL'],
          severity: 'Minor',
          type: 'Maintenance',
          lastUpdated: '2026-08-13T18:02:00.000Z',
        },
      ],
    };
    const container = mountResult('get_incidents', result);

    expect(queryRequired(container, 'section[data-view="service-incidents"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('DC service incidents');
    expect(container.textContent).toContain('Major');
    expect(container.textContent).toContain('RD');
    expect(queryRequired(container, 'time').getAttribute('datetime')).toBe(
      '2026-08-13T18:00:00.000Z',
    );
    const severity = queryRequired<HTMLSelectElement>(container, 'select[name="severity-filter"]');
    const line = queryRequired<HTMLSelectElement>(container, 'select[name="line-filter"]');
    expect(severity.labels?.[0]?.textContent).toContain('Severity');
    expect(line.labels?.[0]?.textContent).toContain('Line');

    severity.value = 'Minor';
    severity.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelectorAll('[data-incident-row]')).toHaveLength(1);
    expect(container.textContent).toContain('Blue Line single tracking');
    expect(container.textContent).not.toContain('Red Line delay');

    severity.value = '';
    line.value = 'RD';
    line.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelectorAll('[data-incident-row]')).toHaveLength(1);
    expect(container.textContent).toContain('Red Line delay');
  });

  it('renders elevator outages with a station filter and operational details', () => {
    const representative = EXPECTED_TOOL_CONTRACTS.get_elevator_incidents.structuredContent;
    const result = {
      ...representative,
      elevatorIncidents: [
        representative.elevatorIncidents[0],
        {
          ...representative.elevatorIncidents[0],
          id: 'EL-2',
          unitName: 'ES-2',
          unitType: 'ESCALATOR',
          stationCode: 'B01',
          stationName: 'Gallery Place',
          locationDescription: 'Arena entrance',
          symptomDescription: 'Out of service',
          description: 'Unscheduled outage',
          estimatedReturnToService: '2026-08-13T22:00:00.000Z',
        },
      ],
    };
    const container = mountResult('get_elevator_incidents', result);

    expect(queryRequired(container, 'section[data-view="elevator-incidents"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('DC elevator and escalator outages');
    expect(container.textContent).toContain('12th St entrance');
    expect(container.textContent).toContain('Return time unavailable');
    const filter = queryRequired<HTMLInputElement>(container, 'input[name="station-filter"]');
    expect(filter.labels?.[0]?.textContent).toContain('Station');

    filter.value = 'gallery';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container.querySelectorAll('[data-elevator-row]')).toHaveLength(1);
    expect(container.textContent).toContain('Gallery Place');
    expect(container.textContent).not.toContain('Metro Center');
  });

  it.each([
    ['1'],
    ['2026-02-31T18:00:00.000Z'],
  ])('rejects an untrustworthy service timestamp: %s', (lastUpdated) => {
    const representative = EXPECTED_TOOL_CONTRACTS.get_incidents.structuredContent;
    const container = mountResult('get_incidents', {
      ...representative,
      incidents: [{ ...representative.incidents[0], lastUpdated }],
    });

    expect(queryRequired(container, '[role="alert"]').textContent).toContain(
      'This service incident result can’t be displayed',
    );
    expect(container.querySelector('time')).toBeNull();
  });

  it.each([
    ['get_incidents', '2026-08-13T18:00:00.000Z'],
    ['get_elevator_incidents', '2026-06-10T14:20:31'],
  ])('accepts the %s producer timestamp format', (toolName, timestamp) => {
    const result = toolName === 'get_incidents'
      ? {
          ...EXPECTED_TOOL_CONTRACTS.get_incidents.structuredContent,
          incidents: [{
            ...EXPECTED_TOOL_CONTRACTS.get_incidents.structuredContent.incidents[0],
            lastUpdated: timestamp,
          }],
        }
      : {
          ...EXPECTED_TOOL_CONTRACTS.get_elevator_incidents.structuredContent,
          elevatorIncidents: [{
            ...EXPECTED_TOOL_CONTRACTS.get_elevator_incidents.structuredContent
              .elevatorIncidents[0],
            outOfServiceAt: timestamp,
            lastUpdated: timestamp,
          }],
        };
    const container = mountResult(toolName, result);

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect([...container.querySelectorAll('time')].some(time => (
      time.getAttribute('datetime') === timestamp
    ))).toBe(true);
  });
});

describe('Transit Board route renderers', () => {
  it('filters and selects bus routes without mutating the source result', () => {
    const representative = EXPECTED_TOOL_CONTRACTS.get_bus_routes.structuredContent;
    const result = {
      ...representative,
      totalRoutes: 2,
      routes: [
        representative.routes[0],
        { id: 'X2', name: 'Benning Road-H Street', description: 'Limited-stop service' },
      ],
    };
    const original = structuredClone(result);
    const container = mountResult('get_bus_routes', result);

    expect(queryRequired(container, 'section[data-view="bus-routes"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('DC bus routes');
    const filter = queryRequired<HTMLInputElement>(container, 'input[name="route-search"]');
    filter.value = 'X2';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container.querySelectorAll('[data-route-row]')).toHaveLength(1);
    const route = queryRequired<HTMLButtonElement>(container, '[data-route-row] button');
    expect(route.type).toBe('button');
    route.click();
    expect(route.getAttribute('aria-pressed')).toBe('true');
    expect(queryRequired(container, '[data-route-detail]').textContent).toContain(
      'Limited-stop service',
    );
    expect(result).toEqual(original);
  });

  it('renders bus-stop search context with filterable, selectable stops', () => {
    const representative = EXPECTED_TOOL_CONTRACTS.get_bus_stops.structuredContent;
    const result = {
      ...representative,
      totalStops: 2,
      searchLocation: { lat: 38.9, lon: -77.03, radiusMeters: 750 },
      stops: [
        representative.stops[0],
        {
          id: '1001196',
          name: '14TH ST NW + H ST NW',
          coordinates: { lat: 38.9002, lon: -77.031 },
          routes: ['X2'],
        },
      ],
    };
    const container = mountResult('get_bus_stops', result);

    expect(queryRequired(container, 'section[data-view="bus-stops"]')).toBeTruthy();
    expect(container.textContent).toContain('750 m around 38.9, -77.03');
    const filter = queryRequired<HTMLInputElement>(container, 'input[name="stop-search"]');
    filter.value = '1001196';
    filter.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container.querySelectorAll('[data-stop-row]')).toHaveLength(1);
    const stop = queryRequired<HTMLButtonElement>(container, '[data-stop-row] button');
    stop.click();
    expect(queryRequired(container, '[data-stop-detail]').textContent).toContain('38.9002');
    expect(queryRequired(container, '[data-stop-detail]').textContent).toContain('X2');
  });

  it('renders only the route-detail fields the server actually produces', () => {
    const result = EXPECTED_TOOL_CONTRACTS.get_route_info.structuredContent;
    const container = mountResult('get_route_info', result);

    expect(queryRequired(container, 'section[data-view="route-detail"]')).toBeTruthy();
    expect(queryRequired(container, 'h1').textContent).toBe('A · 8 Avenue Express');
    expect(container.textContent).toContain('Express service in Manhattan and Brooklyn.');
    expect(container.textContent).toContain('Route A');
    expect(container.textContent).not.toContain('Stops');
    expect(container.querySelector('pre')).toBeNull();
  });

  it('renders the schema-valid all-empty route detail as a dedicated empty view', () => {
    const container = mountResult('get_route_info', {
      city: 'nyc',
      routeId: '',
      shortName: '',
      longName: '',
      description: '',
    });

    expect(queryRequired(container, 'section[data-view="route-detail"]')).toBeTruthy();
    expect(queryRequired(container, '[data-empty-state]').textContent).toContain(
      'No route detail is available',
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    {
      city: 'nyc',
      routeId: '',
      shortName: 'A',
      longName: '',
      description: '',
    },
    {
      city: 'nyc',
      routeId: '',
      shortName: '',
      longName: '',
    },
  ])('keeps partial or missing route detail malformed', result => {
    const container = mountResult('get_route_info', result);

    expect(queryRequired(container, '[role="alert"]').textContent).toContain(
      'This route detail result can’t be displayed',
    );
    expect(container.querySelector('[data-empty-state]')).toBeNull();
  });
});

describe('Transit Board vehicle renderers', () => {
  it('filters live buses by route and plots finite, clamped coordinates accessibly', () => {
    const representative = EXPECTED_TOOL_CONTRACTS.get_bus_positions.structuredContent;
    const result = {
      ...representative,
      routeFilter: null,
      totalBuses: 3,
      buses: [
        representative.buses[0],
        {
          ...representative.buses[0],
          vehicleId: 'V200',
          route: 'X2',
          coordinates: { lat: 1e308, lon: -1e308 },
          headsign: null,
          deviation: null,
        },
        {
          ...representative.buses[0],
          vehicleId: 'V300',
          route: '30N',
          coordinates: { lat: -1e308, lon: 1e308 },
        },
      ],
    };
    const container = mountResult('get_bus_positions', result);

    expect(queryRequired(container, 'section[data-view="bus-positions"]')).toBeTruthy();
    expect(queryRequired(container, 'svg[role="img"] title').textContent).toContain(
      'Live bus position plot',
    );
    expect(queryRequired(container, 'svg desc').textContent).toContain('normalized');
    for (const point of container.querySelectorAll<SVGCircleElement>('circle[data-vehicle-point]')) {
      const x = Number(point.getAttribute('cx'));
      const y = Number(point.getAttribute('cy'));
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(8);
      expect(x).toBeLessThanOrEqual(92);
      expect(y).toBeGreaterThanOrEqual(8);
      expect(y).toBeLessThanOrEqual(92);
    }
    const filter = queryRequired<HTMLSelectElement>(container, 'select[name="route-filter"]');
    filter.value = 'X2';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelectorAll('[data-vehicle-row]')).toHaveLength(1);
    expect(container.querySelectorAll('circle[data-vehicle-point]')).toHaveLength(1);
    expect(container.textContent).toContain('V200');
    expect(container.textContent).not.toContain('V100');
  });

  it('filters trains by line and plots only actual circuit positions', () => {
    const result = EXPECTED_TOOL_CONTRACTS.get_train_positions.structuredContent;
    const container = mountResult('get_train_positions', result);

    expect(queryRequired(container, 'section[data-view="train-positions"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-vehicle-row]')).toHaveLength(2);
    expect(container.querySelectorAll('circle[data-vehicle-point]')).toHaveLength(1);
    expect(queryRequired(container, 'svg desc').textContent).toContain('circuit identifiers');
    const filter = queryRequired<HTMLSelectElement>(container, 'select[name="line-filter"]');
    filter.value = 'RD';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelectorAll('[data-vehicle-row]')).toHaveLength(1);
    expect(container.textContent).toContain('Circuit 1234');
    expect(container.textContent).toContain('Normal');
  });
});

describe('Transit Board rendering boundary', () => {
  it('supports exactly the canonical thirteen tool names in wire order', () => {
    expect(SUPPORTED_RENDERER_NAMES).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('keeps hostile transit text inert while preserving it for the rider', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const container = mountResult('search_stations', {
      city: 'nyc',
      query: hostile,
      results: [{
        id: 'X01',
        name: hostile,
        lines: ['A'],
        coordinates: { lat: 40.7, lon: -73.9 },
        address: null,
      }],
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.textContent).toContain(hostile);
  });

  it('renders an explicit unsupported-result state for malformed required fields', () => {
    const container = mountResult('get_station_predictions', {
      city: 'dc',
      predictions: [],
    });

    const alert = queryRequired(container, '[role="alert"]');
    expect(alert.textContent).toContain('This train arrival result can’t be displayed');
    expect(container.querySelector('pre')).toBeNull();
  });

  it.each([
    {
      toolName: 'get_bus_predictions',
      result: {
        ...EXPECTED_TOOL_CONTRACTS.get_bus_predictions.structuredContent,
        predictions: [{
          ...EXPECTED_TOOL_CONTRACTS.get_bus_predictions.structuredContent.predictions[0],
          minutesAway: Number.NaN,
        }],
      },
      label: 'bus arrival',
    },
    {
      toolName: 'search_stations',
      result: {
        ...EXPECTED_TOOL_CONTRACTS.search_stations.structuredContent,
        results: [{
          ...EXPECTED_TOOL_CONTRACTS.search_stations.structuredContent.results[0],
          coordinates: { lat: Number.POSITIVE_INFINITY, lon: -73.987495 },
        }],
      },
      label: 'station search',
    },
    {
      toolName: 'get_station_transfers',
      result: {
        ...EXPECTED_TOOL_CONTRACTS.get_station_transfers.structuredContent,
        transfers: [{
          ...EXPECTED_TOOL_CONTRACTS.get_station_transfers.structuredContent.transfers[0],
          transferType: 'stairs',
        }],
      },
      label: 'station transfer',
    },
    {
      toolName: 'get_incidents',
      result: {
        ...EXPECTED_TOOL_CONTRACTS.get_incidents.structuredContent,
        incidents: [{
          ...EXPECTED_TOOL_CONTRACTS.get_incidents.structuredContent.incidents[0],
          lastUpdated: 'not-a-timestamp',
        }],
      },
      label: 'service incident',
    },
    {
      toolName: 'get_bus_positions',
      result: {
        ...EXPECTED_TOOL_CONTRACTS.get_bus_positions.structuredContent,
        buses: [{
          ...EXPECTED_TOOL_CONTRACTS.get_bus_positions.structuredContent.buses[0],
          coordinates: { lat: Number.NaN, lon: Number.POSITIVE_INFINITY },
        }],
      },
      label: 'bus position',
    },
    {
      toolName: 'get_train_positions',
      result: {
        ...EXPECTED_TOOL_CONTRACTS.get_train_positions.structuredContent,
        trains: [{
          ...EXPECTED_TOOL_CONTRACTS.get_train_positions.structuredContent.trains[0],
          circuitId: Number.POSITIVE_INFINITY,
        }],
      },
      label: 'train position',
    },
    {
      toolName: 'get_route_info',
      result: { city: 'nyc', routeId: 'A', shortName: 'A', longName: '8 Avenue Express' },
      label: 'route detail',
    },
  ])('rejects malformed $label item fields', ({ toolName, result, label }) => {
    const container = mountResult(toolName, result);
    expect(queryRequired(container, '[role="alert"]').textContent).toContain(
      `This ${label} result can’t be displayed`,
    );
  });

  it.each([
    ['get_incidents', { city: 'dc', incidents: [] }, 'No active service incidents'],
    [
      'get_elevator_incidents',
      { city: 'dc', elevatorIncidents: [] },
      'No elevator or escalator outages',
    ],
    ['get_bus_routes', { city: 'dc', totalRoutes: 0, routes: [] }, 'No bus routes are available'],
    [
      'get_bus_stops',
      { city: 'dc', totalStops: 0, searchLocation: null, stops: [] },
      'No bus stops are available',
    ],
    [
      'get_bus_positions',
      { city: 'dc', routeFilter: null, totalBuses: 0, buses: [] },
      'No live bus positions are available',
    ],
    [
      'get_train_positions',
      { city: 'dc', totalTrains: 0, trains: [] },
      'No live train positions are available',
    ],
  ])('renders the %s empty state', (toolName, result, message) => {
    const container = mountResult(toolName, result);
    expect(queryRequired(container, '[data-empty-state]').textContent).toContain(message);
  });

  it('keeps all new result models immutable and their hostile strings inert', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const cases: Array<[string, unknown]> = [
      ['get_incidents', {
        ...EXPECTED_TOOL_CONTRACTS.get_incidents.structuredContent,
        incidents: [{
          ...EXPECTED_TOOL_CONTRACTS.get_incidents.structuredContent.incidents[0],
          description: hostile,
        }],
      }],
      ['get_elevator_incidents', {
        ...EXPECTED_TOOL_CONTRACTS.get_elevator_incidents.structuredContent,
        elevatorIncidents: [{
          ...EXPECTED_TOOL_CONTRACTS.get_elevator_incidents.structuredContent
            .elevatorIncidents[0],
          stationName: hostile,
        }],
      }],
      ['get_bus_routes', {
        ...EXPECTED_TOOL_CONTRACTS.get_bus_routes.structuredContent,
        routes: [{
          ...EXPECTED_TOOL_CONTRACTS.get_bus_routes.structuredContent.routes[0],
          name: hostile,
        }],
      }],
      ['get_bus_stops', {
        ...EXPECTED_TOOL_CONTRACTS.get_bus_stops.structuredContent,
        stops: [{
          ...EXPECTED_TOOL_CONTRACTS.get_bus_stops.structuredContent.stops[0],
          name: hostile,
        }],
      }],
      ['get_bus_positions', {
        ...EXPECTED_TOOL_CONTRACTS.get_bus_positions.structuredContent,
        buses: [{
          ...EXPECTED_TOOL_CONTRACTS.get_bus_positions.structuredContent.buses[0],
          vehicleId: hostile,
        }],
      }],
      ['get_train_positions', {
        ...EXPECTED_TOOL_CONTRACTS.get_train_positions.structuredContent,
        trains: [{
          ...EXPECTED_TOOL_CONTRACTS.get_train_positions.structuredContent.trains[0],
          destination: hostile,
        }],
      }],
      ['get_route_info', {
        ...EXPECTED_TOOL_CONTRACTS.get_route_info.structuredContent,
        description: hostile,
      }],
    ];

    for (const [toolName, result] of cases) {
      const original = structuredClone(result);
      const container = mountResult(toolName, deepFreeze(result));
      for (const control of container.querySelectorAll<HTMLElement>('button, input, select')) {
        if (control instanceof HTMLButtonElement) {
          control.click();
        } else {
          control.dispatchEvent(new Event(
            control instanceof HTMLSelectElement ? 'change' : 'input',
            { bubbles: true },
          ));
        }
      }
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector('[onerror]')).toBeNull();
      expect(container.textContent).toContain(hostile);
      expect(container.querySelector('pre')).toBeNull();
      expect(result).toEqual(original);
      container.remove();
    }
  });

});
