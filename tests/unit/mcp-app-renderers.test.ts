// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import { EXPECTED_TOOL_CONTRACTS } from '../fixtures/mcp-contracts';
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

describe('Transit Board rendering boundary', () => {
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
  ])('rejects malformed $label item fields', ({ toolName, result, label }) => {
    const container = mountResult(toolName, result);
    expect(queryRequired(container, '[role="alert"]').textContent).toContain(
      `This ${label} result can’t be displayed`,
    );
  });

  it.each([
    'get_incidents',
    'get_elevator_incidents',
    'get_bus_routes',
    'get_bus_stops',
    'get_bus_positions',
    'get_train_positions',
    'get_route_info',
  ])('keeps the Task 3 tool %s intentionally unsupported', (toolName) => {
    const fixture = EXPECTED_TOOL_CONTRACTS[
      toolName as keyof typeof EXPECTED_TOOL_CONTRACTS
    ].structuredContent;
    const container = mountResult(toolName, fixture);

    expect(queryRequired(container, '[data-view="unsupported-tool"]').textContent).toContain(
      'This transit view is not available yet',
    );
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).not.toContain(JSON.stringify(fixture));
  });

});
