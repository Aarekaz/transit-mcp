import { append, element, emptyListState, emptyState, lineBadge, viewHeader } from '../dom';
import type {
  ElevatorIncident,
  ElevatorIncidentsModel,
  ServiceIncident,
  ServiceIncidentsModel,
} from '../model';

function timestamp(label: string, value: string): HTMLTimeElement {
  return element('time', {
    text: `${label} ${value}`,
    attributes: { datetime: value },
  });
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

function incidentRow(incident: ServiceIncident): HTMLLIElement {
  const lines = element('div', {
    className: 'badge-row',
    attributes: { 'aria-label': 'Affected lines' },
  });
  if (incident.linesAffected.length === 0) {
    lines.append(element('span', { className: 'systemwide-label', text: 'Systemwide' }));
  } else {
    for (const line of incident.linesAffected) {
      lines.append(lineBadge(line));
    }
  }
  return element('li', {
    className: 'service-row',
    attributes: { 'data-incident-row': '' },
  }, [
    element('div', { className: 'service-row-heading' }, [
      element('strong', { text: incident.type }),
      element('span', {
        className: 'severity-label',
        text: `Severity: ${incident.severity}`,
      }),
    ]),
    lines,
    element('p', { className: 'service-description', text: incident.description }),
    timestamp('Updated', incident.lastUpdated),
  ]);
}

export function renderServiceIncidents(model: ServiceIncidentsModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view service-view',
    attributes: { 'data-view': 'service-incidents' },
  }, [viewHeader(model.city, `${model.city.toUpperCase()} service incidents`, 'live')]);
  if (model.incidents.length === 0) {
    section.append(emptyState('No active service incidents are reported.'));
    return section;
  }

  const severities = [...new Set(model.incidents.map(incident => incident.severity))]
    .sort((left, right) => left.localeCompare(right));
  const lines = [...new Set(model.incidents.flatMap(incident => incident.linesAffected))]
    .sort((left, right) => left.localeCompare(right));
  const severityFilter = selectFilter(
    'incident-severity-filter',
    'severity-filter',
    'Severity',
    'All severities',
    severities,
  );
  const lineFilter = selectFilter(
    'incident-line-filter',
    'line-filter',
    'Line',
    'All lines',
    lines,
  );
  const list = element('ul', {
    className: 'service-list',
    attributes: { 'aria-label': 'Current service incidents' },
  });

  const renderRows = (): void => {
    list.replaceChildren();
    const visible = model.incidents.filter(incident => (
      (severityFilter.select.value === '' || incident.severity === severityFilter.select.value)
      && (lineFilter.select.value === ''
        || incident.linesAffected.includes(lineFilter.select.value))
    ));
    for (const incident of visible) {
      list.append(incidentRow(incident));
    }
    if (visible.length === 0) {
      list.append(emptyListState('No incidents match these filters.'));
    }
  };
  severityFilter.select.addEventListener('change', renderRows);
  lineFilter.select.addEventListener('change', renderRows);
  renderRows();
  append(
    section,
    element('div', { className: 'service-filters' }, [
      severityFilter.wrapper,
      lineFilter.wrapper,
    ]),
    list,
  );
  return section;
}

function elevatorRow(incident: ElevatorIncident): HTMLLIElement {
  return element('li', {
    className: 'service-row elevator-row',
    attributes: { 'data-elevator-row': '' },
  }, [
    element('div', { className: 'service-row-heading' }, [
      element('strong', { text: incident.stationName }),
      element('span', { className: 'station-code', text: incident.stationCode }),
    ]),
    element('p', {
      className: 'service-unit',
      text: `${incident.unitType} ${incident.unitName}`,
    }),
    element('p', { className: 'service-description', text: incident.symptomDescription }),
    element('p', { className: 'service-location', text: incident.locationDescription }),
    element('p', { className: 'service-description', text: incident.description }),
    element('div', { className: 'time-stack' }, [
      timestamp('Out since', incident.outOfServiceAt),
      incident.estimatedReturnToService === null
        ? element('span', { text: 'Return time unavailable' })
        : timestamp('Estimated return', incident.estimatedReturnToService),
      timestamp('Updated', incident.lastUpdated),
    ]),
  ]);
}

export function renderElevatorIncidents(model: ElevatorIncidentsModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view service-view',
    attributes: { 'data-view': 'elevator-incidents' },
  }, [viewHeader(model.city, 'DC elevator and escalator outages', 'live')]);
  if (model.incidents.length === 0) {
    section.append(emptyState('No elevator or escalator outages are reported.'));
    return section;
  }

  const label = element('label', {
    className: 'field-label',
    text: 'Station',
    attributes: { for: 'elevator-station-filter' },
  });
  const input = element('input', {
    className: 'filter-control',
    attributes: {
      id: 'elevator-station-filter',
      name: 'station-filter',
      type: 'search',
      autocomplete: 'off',
    },
  });
  const list = element('ul', {
    className: 'service-list',
    attributes: { 'aria-label': 'Elevator and escalator outages' },
  });
  const renderRows = (): void => {
    list.replaceChildren();
    const query = input.value.trim().toLocaleLowerCase();
    const visible = model.incidents.filter(incident => (
      incident.stationName.toLocaleLowerCase().includes(query)
      || incident.stationCode.toLocaleLowerCase().includes(query)
    ));
    for (const incident of visible) {
      list.append(elevatorRow(incident));
    }
    if (visible.length === 0) {
      list.append(emptyListState('No outages match this station filter.'));
    }
  };
  input.addEventListener('input', renderRows);
  renderRows();
  append(
    section,
    element('div', { className: 'filter-bar' }, [label, input]),
    list,
  );
  return section;
}
