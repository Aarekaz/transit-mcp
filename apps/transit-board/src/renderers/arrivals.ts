import { append, element, emptyListState, emptyState, lineBadge, viewHeader } from '../dom';
import type { BusArrivalsModel, BusPrediction, RailArrivalsModel } from '../model';

function arrivalsShell(
  view: 'rail-arrivals' | 'bus-arrivals',
  city: string,
  title: string,
): HTMLElement {
  return element('section', {
    className: 'transit-view arrivals-view',
    attributes: { 'data-view': view },
  }, [viewHeader(city, title, 'live')]);
}

function arrivalColumns(): HTMLElement {
  return element('div', {
    className: 'arrival-columns',
    attributes: { 'aria-hidden': 'true' },
  }, [
    element('span', { text: 'Line' }),
    element('span', { text: 'Destination' }),
    element('span', { text: 'Due' }),
  ]);
}

function railDue(prediction: RailArrivalsModel['predictions'][number]): string {
  if (prediction.arrivalStatus === 'ARRIVING') {
    return 'Arriving';
  }
  if (prediction.arrivalStatus === 'BOARDING') {
    return 'Boarding';
  }
  if (prediction.arrivalStatus === 'DELAYED') {
    return 'Delayed';
  }
  return prediction.minutesAway === null ? 'Scheduled' : `${prediction.minutesAway} min`;
}

function railRow(prediction: RailArrivalsModel['predictions'][number]): HTMLLIElement {
  const metadata = [
    prediction.direction,
    prediction.track ? `Track ${prediction.track}` : null,
    prediction.cars ? `${prediction.cars} cars` : null,
  ].filter((item): item is string => item !== null);

  return element('li', {
    className: 'arrival-row',
    attributes: { 'data-arrival-row': '' },
  }, [
    element('div', { className: 'arrival-route' }, [lineBadge(prediction.line)]),
    element('div', { className: 'arrival-destination' }, [
      element('strong', { text: prediction.destination }),
      element('span', {
        className: 'arrival-metadata',
        text: metadata.length > 0 ? metadata.join(' · ') : 'Platform details unavailable',
      }),
    ]),
    element('strong', {
      className: `arrival-due arrival-due--${prediction.arrivalStatus.toLowerCase()}`,
      text: railDue(prediction),
    }),
  ]);
}

export function renderRailArrivals(model: RailArrivalsModel): HTMLElement {
  const section = arrivalsShell(
    'rail-arrivals',
    model.city,
    `${model.station} train arrivals`,
  );
  if (model.predictions.length === 0) {
    append(section, emptyState('No train arrivals are available for this station right now.'));
    return section;
  }

  const list = element('ul', {
    className: 'arrival-list',
    attributes: { 'aria-label': 'Upcoming train arrivals' },
  });
  for (const prediction of model.predictions) {
    append(list, railRow(prediction));
  }
  append(section, arrivalColumns(), list);
  return section;
}

function busRow(prediction: BusPrediction): HTMLLIElement {
  const identifiers = [
    prediction.vehicleId ? `Vehicle ${prediction.vehicleId}` : null,
    prediction.tripId ? `Trip ${prediction.tripId}` : null,
  ].filter((item): item is string => item !== null);

  return element('li', {
    className: 'arrival-row',
    attributes: { 'data-arrival-row': '' },
  }, [
    element('div', { className: 'arrival-route' }, [lineBadge(prediction.route)]),
    element('div', { className: 'arrival-destination' }, [
      element('strong', { text: prediction.direction }),
      element('span', {
        className: 'arrival-metadata',
        text: identifiers.length > 0 ? identifiers.join(' · ') : 'Vehicle assignment pending',
      }),
    ]),
    element('strong', { className: 'arrival-due', text: `${prediction.minutesAway} min` }),
  ]);
}

export function renderBusArrivals(model: BusArrivalsModel): HTMLElement {
  const section = arrivalsShell(
    'bus-arrivals',
    model.city,
    `Stop ${model.stopId} bus arrivals`,
  );
  if (model.predictions.length === 0) {
    append(section, emptyState('No bus arrivals are available for this stop right now.'));
    return section;
  }

  const routes = [...new Set(model.predictions.map(prediction => prediction.route))]
    .sort((left, right) => left.localeCompare(right));
  const label = element('label', {
    className: 'field-label',
    text: 'Route',
    attributes: { for: 'bus-route-filter' },
  });
  const select = element('select', {
    className: 'filter-control',
    attributes: { id: 'bus-route-filter', name: 'route-filter' },
  });
  select.append(element('option', { text: 'All routes', attributes: { value: '' } }));
  for (const route of routes) {
    select.append(element('option', { text: route, attributes: { value: route } }));
  }
  const controls = element('div', { className: 'filter-bar' }, [label, select]);
  const list = element('ul', {
    className: 'arrival-list',
    attributes: { 'aria-label': 'Upcoming bus arrivals' },
  });

  const renderRows = (): void => {
    list.replaceChildren();
    const visible = select.value === ''
      ? model.predictions
      : model.predictions.filter(prediction => prediction.route === select.value);
    for (const prediction of visible) {
      list.append(busRow(prediction));
    }
    if (visible.length === 0) {
      list.append(emptyListState('No arrivals match this route.'));
    }
  };

  select.addEventListener('change', renderRows);
  renderRows();
  append(section, controls, arrivalColumns(), list);
  return section;
}
