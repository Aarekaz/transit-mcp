import {
  append,
  button,
  element,
  emptyListState,
  emptyState,
  lineBadge,
  viewHeader,
} from '../dom';
import type {
  LineStationsModel,
  Station,
  StationDirectoryModel,
  StationSearchModel,
  StationTransfer,
  StationTransfersModel,
} from '../model';

function stationDetail(station: Station): HTMLElement {
  const addressParts = station.address
    ? [
      station.address.street,
      [station.address.city, station.address.state].filter(Boolean).join(', '),
      station.address.zip,
    ].filter((part): part is string => Boolean(part))
    : [];
  const detail = element('aside', {
    className: 'station-detail',
    attributes: { 'data-station-detail': '', 'aria-live': 'polite' },
  }, [
    element('p', { className: 'detail-kicker', text: `Station ${station.id}` }),
    element('h2', { text: station.name }),
    element('div', { className: 'badge-row', attributes: { 'aria-label': 'Lines served' } },
      station.lines.map(lineBadge)),
    element('p', {
      className: 'detail-address',
      text: addressParts.length > 0 ? addressParts.join(' · ') : 'Address unavailable',
    }),
    element('p', {
      className: 'detail-coordinates',
      text: `${station.coordinates.lat}, ${station.coordinates.lon}`,
    }),
  ]);
  if (station.lines.length > 1) {
    detail.append(element('p', { className: 'transfer-marker', text: 'Transfer station' }));
  }
  return detail;
}

function stationRow(
  station: Station,
  onSelect: (station: Station, control: HTMLButtonElement) => void,
): HTMLLIElement {
  const control = button(station.name, 'station-select', () => onSelect(station, control));
  control.setAttribute('aria-pressed', 'false');
  control.append(element('span', { className: 'station-code', text: station.id }));
  const badges = element('span', { className: 'badge-row station-lines' });
  for (const line of station.lines) {
    badges.append(lineBadge(line));
  }
  control.append(badges);
  return element('li', {
    className: 'station-row',
    attributes: { 'data-station-row': '' },
  }, [control]);
}

function fillStationList(
  list: HTMLOListElement | HTMLUListElement,
  stations: readonly Station[],
  detailHost: HTMLElement,
  controls: HTMLButtonElement[] = [],
): void {
  list.replaceChildren();
  for (const station of stations) {
    const row = stationRow(station, (selected, selectedControl) => {
      for (const control of controls) {
        control.setAttribute('aria-pressed', String(control === selectedControl));
      }
      detailHost.replaceChildren(stationDetail(selected));
    });
    const control = row.querySelector<HTMLButtonElement>('button');
    if (control) {
      controls.push(control);
    }
    list.append(row);
  }
}

function filterInput(id: string, labelText: string, ariaLabel?: string): {
  wrapper: HTMLElement;
  input: HTMLInputElement;
} {
  const label = element('label', {
    className: 'field-label',
    text: labelText,
    attributes: { for: id },
  });
  const input = element('input', {
    className: 'filter-control',
    attributes: {
      id,
      type: 'search',
      ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
      autocomplete: 'off',
    },
  });
  return { wrapper: element('div', { className: 'filter-bar' }, [label, input]), input };
}

export function renderStationSearch(model: StationSearchModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view directory-view',
    attributes: { 'data-view': 'station-search' },
  }, [viewHeader(model.city, `Stations matching “${model.query}”`, 'directory')]);
  const { wrapper, input } = filterInput('station-search-filter', 'Filter stations');
  const list = element('ul', {
    className: 'station-list',
    attributes: { 'data-station-list': '', 'aria-label': 'Station search results' },
  });
  const detailHost = element('div', { className: 'detail-host' });

  const renderRows = (): void => {
    const query = input.value.trim().toLocaleLowerCase();
    const matches = model.stations.filter(station => (
      station.name.toLocaleLowerCase().includes(query)
      || station.id.toLocaleLowerCase().includes(query)
      || station.lines.some(line => line.toLocaleLowerCase().includes(query))
    ));
    detailHost.replaceChildren();
    fillStationList(list, matches, detailHost);
    if (matches.length === 0) {
      list.append(emptyListState(
        model.stations.length === 0
          ? 'No stations were found for this search.'
          : 'No stations match this filter.',
      ));
    }
  };

  input.addEventListener('input', renderRows);
  renderRows();
  append(section, wrapper, element('div', { className: 'directory-layout' }, [list, detailHost]));
  return section;
}

export function renderLineStations(model: LineStationsModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view directory-view',
    attributes: { 'data-view': 'line-stations' },
  }, [viewHeader(model.city, `Line ${model.line} stations`, 'directory')]);
  if (model.stations.length === 0) {
    section.append(emptyState(`No stations are listed for line ${model.line}.`));
    return section;
  }
  const list = element('ol', {
    className: 'station-list station-list--ordered',
    attributes: { 'data-station-list': '', 'aria-label': `Stations on line ${model.line}` },
  });
  const detailHost = element('div', { className: 'detail-host' });
  fillStationList(list, model.stations, detailHost);
  section.append(element('div', { className: 'directory-layout' }, [list, detailHost]));
  return section;
}

function stationLines(stations: readonly Station[]): string[] {
  const lines = new Set<string>();
  for (const station of stations) {
    if (station.lines.length === 0) {
      lines.add('Unassigned');
    }
    for (const line of station.lines) {
      lines.add(line);
    }
  }
  return [...lines].sort((left, right) => left.localeCompare(right));
}

export function renderStationDirectory(model: StationDirectoryModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view directory-view',
    attributes: { 'data-view': 'station-directory' },
  }, [viewHeader(model.city, `${model.city.toUpperCase()} station directory`, 'directory')]);
  const summary = element('p', {
    className: 'directory-summary',
    text: `${model.totalStations} stations reported`,
  });
  const { wrapper: filter, input } = filterInput(
    'station-directory-filter',
    'Find a station',
    'Filter station directory',
  );
  const lineControls = element('div', {
    className: 'line-controls',
    attributes: { 'aria-label': 'Focus directory by line', role: 'group' },
  });
  const groupsHost = element('div', { className: 'network-groups' });
  const detailHost = element('div', { className: 'detail-host' });
  const lines = stationLines(model.stations);
  let focusedLine: string | null = null;
  const focusButtons = new Map<string, HTMLButtonElement>();

  const renderGroups = (): void => {
    groupsHost.replaceChildren();
    detailHost.replaceChildren();
    const stationControls: HTMLButtonElement[] = [];
    const query = input.value.trim().toLocaleLowerCase();
    const visibleLines = focusedLine === null ? lines : [focusedLine];
    let visibleStationCount = 0;
    for (const line of visibleLines) {
      const stations = model.stations.filter(station => {
        const servesLine = line === 'Unassigned'
          ? station.lines.length === 0
          : station.lines.includes(line);
        const matches = station.name.toLocaleLowerCase().includes(query)
          || station.id.toLocaleLowerCase().includes(query);
        return servesLine && matches;
      });
      if (stations.length === 0) {
        continue;
      }
      visibleStationCount += stations.length;
      const list = element('ul', {
        className: 'station-list',
        attributes: { 'aria-label': `${line} line stations` },
      });
      fillStationList(list, stations, detailHost, stationControls);
      groupsHost.append(element('section', { className: 'network-group' }, [
        element('h2', { text: line === 'Unassigned' ? line : `Line ${line}` }),
        list,
      ]));
    }
    if (visibleStationCount === 0) {
      groupsHost.append(emptyState(
        model.stations.length === 0
          ? 'No stations are available in this directory.'
          : 'No stations match this filter.',
      ));
    }
  };

  for (const line of lines) {
    const control = button(line, 'line-focus', () => {
      focusedLine = focusedLine === line ? null : line;
      for (const [candidate, candidateControl] of focusButtons) {
        candidateControl.setAttribute('aria-pressed', String(candidate === focusedLine));
      }
      renderGroups();
    });
    control.setAttribute('aria-pressed', 'false');
    control.setAttribute('data-line-focus', '');
    focusButtons.set(line, control);
    lineControls.append(control);
  }
  input.addEventListener('input', renderGroups);
  renderGroups();
  append(
    section,
    summary,
    element('div', { className: 'directory-controls' }, [filter, lineControls]),
    element('div', { className: 'directory-layout' }, [groupsHost, detailHost]),
  );
  return section;
}

function transferDetail(transfer: StationTransfer): HTMLElement {
  return element('aside', {
    className: 'station-detail',
    attributes: { 'data-transfer-detail': '', 'aria-live': 'polite' },
  }, [
    element('p', { className: 'detail-kicker', text: `Station ${transfer.toStationId}` }),
    element('h2', { text: transfer.toStationName }),
    element('p', {
      className: 'transfer-marker',
      text: transfer.transferType === 'platform' ? 'In-station transfer' : 'Nearby transfer',
    }),
    element('p', {
      text: `${transfer.walkTimeMinutes} min walk · ${transfer.walkTimeSeconds} seconds`,
    }),
  ]);
}

export function renderStationTransfers(model: StationTransfersModel): HTMLElement {
  const section = element('section', {
    className: 'transit-view directory-view',
    attributes: { 'data-view': 'station-transfers' },
  }, [viewHeader(model.city, `Transfers from ${model.stationName}`, 'directory')]);
  section.append(element('p', {
    className: 'directory-summary',
    text: `Source ${model.stationId} · ${model.totalTransfers} transfer options`,
  }));
  if (model.transfers.length === 0) {
    section.append(emptyState('No transfer connections are listed for this station.'));
    return section;
  }

  const list = element('ul', {
    className: 'station-list transfer-list',
    attributes: { 'aria-label': `Transfers from ${model.stationName}` },
  });
  const detailHost = element('div', { className: 'detail-host' });
  const controls: HTMLButtonElement[] = [];
  for (const transfer of model.transfers) {
    const control = button(transfer.toStationName, 'station-select', () => {
      for (const candidate of controls) {
        candidate.setAttribute('aria-pressed', String(candidate === control));
      }
      detailHost.replaceChildren(transferDetail(transfer));
    });
    control.setAttribute('aria-pressed', 'false');
    control.append(element('span', {
      className: 'station-code',
      text: `${transfer.walkTimeMinutes} min · ${transfer.transferType}`,
    }));
    controls.push(control);
    list.append(element('li', {
      className: 'station-row',
      attributes: { 'data-transfer-row': '' },
    }, [control]));
  }
  section.append(element('div', { className: 'directory-layout' }, [list, detailHost]));
  return section;
}
