import { append, button, element, emptyListState, emptyState, lineBadge, viewHeader } from '../dom';
import type { BusRoute, BusRoutesModel, BusStop, BusStopsModel, RouteDetailModel } from '../model';

function searchControl(
  id: string,
  name: string,
  labelText: string,
): { wrapper: HTMLElement; input: HTMLInputElement } {
  const label = element('label', {
    className: 'field-label',
    text: labelText,
    attributes: { for: id },
  });
  const input = element('input', {
    className: 'filter-control',
    attributes: { id, name, type: 'search', autocomplete: 'off' },
  });
  return { wrapper: element('div', { className: 'filter-bar' }, [label, input]), input };
}

function routeDetail(route: BusRoute): HTMLElement {
  return element('aside', {
    className: 'route-detail-panel',
    attributes: { 'data-route-detail': '', 'aria-live': 'polite' },
  }, [
    element('p', { className: 'detail-kicker', text: `Route ${route.id}` }),
    element('h2', { text: route.name }),
    element('p', {
      className: 'detail-description',
      text: route.description ?? 'No route description is available.',
    }),
  ]);
}

export function renderBusRoutes(model: BusRoutesModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view directory-view route-view',
    attributes: { 'data-view': 'bus-routes' },
  }, [viewHeader(model.city, 'DC bus routes', 'directory')]);
  section.append(element('p', {
    className: 'directory-summary',
    text: `${model.totalRoutes} routes reported`,
  }));
  if (model.routes.length === 0) {
    section.append(emptyState('No bus routes are available.'));
    return section;
  }

  const { wrapper, input } = searchControl('bus-route-search', 'route-search', 'Find a route');
  const list = element('ul', {
    className: 'route-list',
    attributes: { 'aria-label': 'DC bus routes' },
  });
  const detailHost = element('div', { className: 'detail-host' });
  const renderRows = (): void => {
    list.replaceChildren();
    detailHost.replaceChildren();
    const query = input.value.trim().toLocaleLowerCase();
    const visible = model.routes.filter(route => (
      route.id.toLocaleLowerCase().includes(query)
      || route.name.toLocaleLowerCase().includes(query)
      || (route.description?.toLocaleLowerCase().includes(query) ?? false)
    ));
    const controls: HTMLButtonElement[] = [];
    for (const route of visible) {
      const control = button(`${route.id} · ${route.name}`, 'route-select', () => {
        for (const candidate of controls) {
          candidate.setAttribute('aria-pressed', String(candidate === control));
        }
        detailHost.replaceChildren(routeDetail(route));
      });
      control.setAttribute('aria-pressed', 'false');
      controls.push(control);
      list.append(element('li', {
        className: 'route-row',
        attributes: { 'data-route-row': '' },
      }, [control]));
    }
    if (visible.length === 0) {
      list.append(emptyListState('No bus routes match this filter.'));
    }
  };
  input.addEventListener('input', renderRows);
  renderRows();
  append(section, wrapper, element('div', { className: 'directory-layout' }, [list, detailHost]));
  return section;
}

function stopDetail(stop: BusStop): HTMLElement {
  const badges = element('div', {
    className: 'badge-row',
    attributes: { 'aria-label': 'Routes serving this stop' },
  });
  if (stop.routes.length === 0) {
    badges.append(element('span', { className: 'systemwide-label', text: 'No routes listed' }));
  } else {
    for (const route of stop.routes) {
      badges.append(lineBadge(route));
    }
  }
  return element('aside', {
    className: 'route-detail-panel',
    attributes: { 'data-stop-detail': '', 'aria-live': 'polite' },
  }, [
    element('p', { className: 'detail-kicker', text: `Stop ${stop.id}` }),
    element('h2', { text: stop.name }),
    badges,
    element('p', {
      className: 'detail-coordinates',
      text: `${stop.coordinates.lat}, ${stop.coordinates.lon}`,
    }),
  ]);
}

function searchLocationText(model: BusStopsModel): string {
  if (model.searchLocation === null) {
    return `${model.totalStops} stops reported systemwide`;
  }
  const radius = model.searchLocation.radiusMeters === null
    ? 'Unspecified radius'
    : `${model.searchLocation.radiusMeters} m`;
  return `${radius} around ${model.searchLocation.lat}, ${model.searchLocation.lon}`;
}

export function renderBusStops(model: BusStopsModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view directory-view route-view',
    attributes: { 'data-view': 'bus-stops' },
  }, [viewHeader(model.city, 'DC bus stops', 'directory')]);
  section.append(element('p', { className: 'directory-summary', text: searchLocationText(model) }));
  if (model.stops.length === 0) {
    section.append(emptyState('No bus stops are available for this search.'));
    return section;
  }

  const { wrapper, input } = searchControl('bus-stop-search', 'stop-search', 'Find a stop');
  const list = element('ul', {
    className: 'route-list',
    attributes: { 'aria-label': 'DC bus stops' },
  });
  const detailHost = element('div', { className: 'detail-host' });
  const renderRows = (): void => {
    list.replaceChildren();
    detailHost.replaceChildren();
    const query = input.value.trim().toLocaleLowerCase();
    const visible = model.stops.filter(stop => (
      stop.id.toLocaleLowerCase().includes(query)
      || stop.name.toLocaleLowerCase().includes(query)
      || stop.routes.some(route => route.toLocaleLowerCase().includes(query))
    ));
    const controls: HTMLButtonElement[] = [];
    for (const stop of visible) {
      const control = button(`${stop.name} · ${stop.id}`, 'route-select', () => {
        for (const candidate of controls) {
          candidate.setAttribute('aria-pressed', String(candidate === control));
        }
        detailHost.replaceChildren(stopDetail(stop));
      });
      control.setAttribute('aria-pressed', 'false');
      controls.push(control);
      list.append(element('li', {
        className: 'route-row',
        attributes: { 'data-stop-row': '' },
      }, [control]));
    }
    if (visible.length === 0) {
      list.append(emptyListState('No bus stops match this filter.'));
    }
  };
  input.addEventListener('input', renderRows);
  renderRows();
  append(section, wrapper, element('div', { className: 'directory-layout' }, [list, detailHost]));
  return section;
}

export function renderRouteDetail(model: RouteDetailModel): HTMLElement {
  return element('section', {
    className: 'transit-view route-detail-view',
    attributes: { 'data-view': 'route-detail' },
  }, [
    viewHeader(model.city, `${model.shortName} · ${model.longName}`, 'directory'),
    element('article', { className: 'route-detail-panel' }, [
      element('p', { className: 'detail-kicker', text: `Route ${model.routeId}` }),
      element('h2', { text: 'Service description' }),
      element('p', { className: 'detail-description', text: model.description }),
    ]),
  ]);
}
