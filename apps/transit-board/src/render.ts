import { clear, element } from './dom';
import { isSupportedToolName, narrowToolResult, type TransitRenderModel } from './model';
import { renderBusArrivals, renderRailArrivals } from './renderers/arrivals';
import { renderBusRoutes, renderBusStops, renderRouteDetail } from './renderers/routes';
import { renderElevatorIncidents, renderServiceIncidents } from './renderers/service';
import {
  renderLineStations,
  renderStationDirectory,
  renderStationSearch,
  renderStationTransfers,
} from './renderers/stations';
import { renderBusPositions, renderTrainPositions } from './renderers/vehicles';

function renderModel(model: TransitRenderModel): HTMLElement {
  switch (model.kind) {
    case 'rail-arrivals':
      return renderRailArrivals(model);
    case 'bus-arrivals':
      return renderBusArrivals(model);
    case 'station-search':
      return renderStationSearch(model);
    case 'line-stations':
      return renderLineStations(model);
    case 'station-directory':
      return renderStationDirectory(model);
    case 'station-transfers':
      return renderStationTransfers(model);
    case 'service-incidents':
      return renderServiceIncidents(model);
    case 'elevator-incidents':
      return renderElevatorIncidents(model);
    case 'bus-routes':
      return renderBusRoutes(model);
    case 'bus-stops':
      return renderBusStops(model);
    case 'bus-positions':
      return renderBusPositions(model);
    case 'train-positions':
      return renderTrainPositions(model);
    case 'route-detail':
      return renderRouteDetail(model);
  }
}

function unsupportedTool(): HTMLElement {
  return element('section', {
    className: 'transit-view state-view',
    attributes: { 'data-view': 'unsupported-tool' },
  }, [
    element('p', { className: 'board-kicker', text: 'Metro MCP · Transit Board' }),
    element('h1', { text: 'This transit view is not available yet' }),
    element('p', { text: 'The text result remains available in the conversation.' }),
  ]);
}

function unsupportedResult(viewLabel: string): HTMLElement {
  return element('section', {
    className: 'transit-view state-view state-view--error',
    attributes: { 'data-view': 'unsupported-result', role: 'alert' },
  }, [
    element('p', { className: 'board-kicker', text: 'Metro MCP · Result unavailable' }),
    element('h1', { text: `This ${viewLabel} result can’t be displayed` }),
    element('p', { text: 'Required transit fields are missing or invalid.' }),
  ]);
}

export function renderToolResult(
  container: HTMLElement,
  toolName: string,
  structuredContent: unknown,
): void {
  clear(container);
  container.setAttribute('aria-busy', 'false');
  if (!isSupportedToolName(toolName)) {
    container.append(unsupportedTool());
    return;
  }

  const result = narrowToolResult(toolName, structuredContent);
  container.append(result.ok ? renderModel(result.model) : unsupportedResult(result.viewLabel));
}
