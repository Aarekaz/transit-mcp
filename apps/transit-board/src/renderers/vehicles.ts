import { append, element, emptyState, lineBadge, viewHeader } from '../dom';
import type {
  BusPosition,
  BusPositionsModel,
  TrainPosition,
  TrainPositionsModel,
} from '../model';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PLOT_MIN = 8;
const PLOT_MAX = 92;

function clampPlot(value: number): number {
  return Math.min(PLOT_MAX, Math.max(PLOT_MIN, value));
}

function normalize(values: readonly number[]): number[] {
  if (values.length === 0) {
    return [];
  }
  let maxAbsolute = 0;
  for (const value of values) {
    maxAbsolute = Math.max(maxAbsolute, Math.abs(value));
  }
  const scaled = maxAbsolute === 0 ? values.map(() => 0) : values.map(value => value / maxAbsolute);
  let minimum = scaled[0] ?? 0;
  let maximum = minimum;
  for (const value of scaled) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const span = maximum - minimum;
  if (span === 0) {
    return scaled.map(() => 50);
  }
  return scaled.map(value => clampPlot(PLOT_MIN + ((value - minimum) / span) * (PLOT_MAX - PLOT_MIN)));
}

function svgElement<TagName extends keyof SVGElementTagNameMap>(
  tagName: TagName,
): SVGElementTagNameMap[TagName] {
  return document.createElementNS(SVG_NS, tagName);
}

function plotShell(titleText: string, descriptionText: string, idPrefix: string): SVGSVGElement {
  const svg = svgElement('svg');
  const title = svgElement('title');
  const description = svgElement('desc');
  const titleId = `${idPrefix}-title`;
  const descriptionId = `${idPrefix}-description`;
  title.id = titleId;
  title.textContent = titleText;
  description.id = descriptionId;
  description.textContent = descriptionText;
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-labelledby', `${titleId} ${descriptionId}`);
  svg.classList.add('vehicle-plot');
  svg.append(title, description);
  return svg;
}

function addPoint(svg: SVGSVGElement, x: number, y: number, label: string): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }
  const point = svgElement('circle');
  const title = svgElement('title');
  point.setAttribute('cx', String(clampPlot(x)));
  point.setAttribute('cy', String(clampPlot(y)));
  point.setAttribute('r', '3.4');
  point.setAttribute('data-vehicle-point', '');
  title.textContent = label;
  point.append(title);
  svg.append(point);
}

function selectFilter(
  id: string,
  name: string,
  labelText: string,
  allText: string,
  values: readonly string[],
): { wrapper: HTMLElement; select: HTMLSelectElement } {
  const label = element('label', {
    className: 'field-label',
    text: labelText,
    attributes: { for: id },
  });
  const select = element('select', {
    className: 'filter-control',
    attributes: { id, name },
  });
  select.append(element('option', { text: allText, attributes: { value: '' } }));
  for (const value of values) {
    select.append(element('option', { text: value, attributes: { value } }));
  }
  return { wrapper: element('div', { className: 'filter-bar' }, [label, select]), select };
}

function busPlot(buses: readonly BusPosition[]): SVGSVGElement {
  const svg = plotShell(
    'Live bus position plot',
    'Bus longitude and latitude are normalized to this plot; exact coordinates remain in the list.',
    'bus-position-plot',
  );
  const xValues = normalize(buses.map(bus => bus.coordinates.lon));
  const yValues = normalize(buses.map(bus => bus.coordinates.lat)).map(value => 100 - value);
  buses.forEach((bus, index) => {
    addPoint(svg, xValues[index] ?? 50, yValues[index] ?? 50, `${bus.route} vehicle ${bus.vehicleId}`);
  });
  return svg;
}

function busRow(bus: BusPosition): HTMLLIElement {
  const deviation = bus.deviation === null
    ? 'Schedule deviation unavailable'
    : bus.deviation === 0
      ? 'On schedule'
      : `${Math.abs(bus.deviation)} min ${bus.deviation < 0 ? 'early' : 'late'}`;
  return element('li', {
    className: 'vehicle-row',
    attributes: { 'data-vehicle-row': '' },
  }, [
    element('div', { className: 'vehicle-heading' }, [
      lineBadge(bus.route),
      element('strong', { text: bus.headsign ?? bus.direction }),
      element('span', { className: 'station-code', text: `Vehicle ${bus.vehicleId}` }),
    ]),
    element('p', { text: bus.direction }),
    element('p', { text: deviation }),
    element('p', {
      className: 'detail-coordinates',
      text: `${bus.coordinates.lat}, ${bus.coordinates.lon}`,
    }),
    element('time', {
      text: `Updated ${bus.lastUpdated}`,
      attributes: { datetime: bus.lastUpdated },
    }),
  ]);
}

export function renderBusPositions(model: BusPositionsModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view vehicle-view',
    attributes: { 'data-view': 'bus-positions' },
  }, [viewHeader(model.city, 'DC live bus positions', 'live')]);
  if (model.buses.length === 0) {
    section.append(emptyState('No live bus positions are available.'));
    return section;
  }
  const routes = [...new Set(model.buses.map(bus => bus.route))]
    .sort((left, right) => left.localeCompare(right));
  const filter = selectFilter(
    'bus-position-route-filter',
    'route-filter',
    'Route',
    'All routes',
    routes,
  );
  if (model.routeFilter !== null && routes.includes(model.routeFilter)) {
    filter.select.value = model.routeFilter;
  }
  const plotHost = element('div', { className: 'plot-host' });
  const list = element('ul', {
    className: 'vehicle-list',
    attributes: { 'aria-label': 'Live buses' },
  });
  const renderRows = (): void => {
    const visible = filter.select.value === ''
      ? model.buses
      : model.buses.filter(bus => bus.route === filter.select.value);
    plotHost.replaceChildren(busPlot(visible));
    list.replaceChildren(...visible.map(busRow));
  };
  filter.select.addEventListener('change', renderRows);
  renderRows();
  append(section, filter.wrapper, plotHost, list);
  return section;
}

function trainPlot(trains: readonly TrainPosition[]): SVGSVGElement {
  const svg = plotShell(
    'Live train circuit position plot',
    'Available circuit identifiers are normalized horizontally; direction determines the rail lane.',
    'train-position-plot',
  );
  const plotted = trains.filter((train): train is TrainPosition & { circuitId: number } => (
    train.circuitId !== null && Number.isFinite(train.circuitId)
  ));
  const xValues = normalize(plotted.map(train => train.circuitId));
  plotted.forEach((train, index) => {
    const y = train.direction === 'Northbound/Eastbound' ? 32 : 68;
    addPoint(svg, xValues[index] ?? 50, y, `${train.line ?? 'Unassigned'} train ${train.trainId}`);
  });
  return svg;
}

function trainRow(train: TrainPosition): HTMLLIElement {
  const metadata = [
    train.trainNumber ? `Train ${train.trainNumber}` : `Train ${train.trainId}`,
    train.carCount === null ? null : `${train.carCount} cars`,
    train.circuitId === null ? 'Circuit unavailable' : `Circuit ${train.circuitId}`,
    train.secondsAtLocation === null ? null : `${train.secondsAtLocation} sec at location`,
  ].filter((value): value is string => value !== null);
  return element('li', {
    className: 'vehicle-row',
    attributes: { 'data-vehicle-row': '' },
  }, [
    element('div', { className: 'vehicle-heading' }, [
      lineBadge(train.line ?? '—'),
      element('strong', { text: train.destination ?? 'Destination unavailable' }),
      element('span', { className: 'station-code', text: train.trainId }),
    ]),
    element('p', { text: train.direction }),
    element('p', { text: metadata.join(' · ') }),
    element('p', { text: train.serviceType ?? 'Service status unavailable' }),
  ]);
}

export function renderTrainPositions(model: TrainPositionsModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view vehicle-view',
    attributes: { 'data-view': 'train-positions' },
  }, [viewHeader(model.city, 'DC live train positions', 'live')]);
  if (model.trains.length === 0) {
    section.append(emptyState('No live train positions are available.'));
    return section;
  }
  const lines = [...new Set(model.trains.map(train => train.line ?? 'Unassigned'))]
    .sort((left, right) => left.localeCompare(right));
  const filter = selectFilter(
    'train-position-line-filter',
    'line-filter',
    'Line',
    'All lines',
    lines,
  );
  const plotHost = element('div', { className: 'plot-host' });
  const list = element('ul', {
    className: 'vehicle-list',
    attributes: { 'aria-label': 'Live trains' },
  });
  const renderRows = (): void => {
    const visible = filter.select.value === ''
      ? model.trains
      : model.trains.filter(train => (train.line ?? 'Unassigned') === filter.select.value);
    plotHost.replaceChildren(trainPlot(visible));
    list.replaceChildren(...visible.map(trainRow));
  };
  filter.select.addEventListener('change', renderRows);
  renderRows();
  append(section, filter.wrapper, plotHost, list);
  return section;
}
