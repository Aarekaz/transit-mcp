import { MCP_PROTOCOL_VERSION, SERVER_VERSION } from './config';

export function getServerInfo(baseUrl: string, timestamp = new Date().toISOString()) {
  return {
    name: 'Transit MCP',
    version: SERVER_VERSION,
    description: 'MCP server for DC Metro, NYC Subway, and San Francisco Bay Area transit',
    protocolVersion: MCP_PROTOCOL_VERSION,
    status: 'operational',
    timestamp,
    author: 'Anurag Dhungana',
    links: {
      author: 'https://anuragd.me',
      github: 'https://github.com/Aarekaz/metro-mcp',
      mcpServer: `${baseUrl}/mcp`,
      mcpServerLegacy: `${baseUrl}/sse`,
      website: baseUrl,
      documentation: 'https://transitmcp.com/docs/',
      privacy: 'https://transitmcp.com/privacy/',
      terms: 'https://transitmcp.com/terms/',
      support: 'https://transitmcp.com/support/',
    },
    capabilities: {
      tools: {},
    },
    cities: [
      {
        code: 'dc',
        name: 'Washington DC Metro',
        system: 'WMATA',
        stations: 102,
        lines: 6,
        features: ['real-time', 'alerts', 'elevators', 'search', 'line-info', 'bus-routes', 'bus-stops', 'bus-positions', 'train-positions']
      },
      {
        code: 'nyc',
        name: 'New York City Subway',
        system: 'MTA',
        stations: 496,
        lines: 29,
        features: ['real-time', 'alerts', 'search', 'line-info', 'transfers', 'route-info']
      },
      {
        code: 'sfbay',
        name: 'San Francisco Bay Area transit',
        system: '511 SF Bay',
        stations: 20627,
        lines: 671,
        features: ['real-time', 'alerts', 'search', 'routes', 'vehicle-positions', 'regional-coverage']
      }
    ],
    stats: {
      totalStations: 21225,
      totalLines: 706,
      citiesSupported: 3,
      toolsAvailable: 18,
      resourcesAvailable: 3,
      promptsAvailable: 3
    },
    endpoints: {
      mcp: ['/mcp', '/sse'],
      mcpRecommended: '/mcp'
    },
    transport: {
      type: 'streamable-http',
      stateless: true,
      note: 'MCP stateless Streamable HTTP transport with request-scoped JSON or SSE responses.',
      supportsJSON: true,
      supportsSSEResponses: true,
      supportsServerPush: false,
      supportsResumability: false
    },
    authentication: { type: 'none' },
    tools: [
      'get_station_predictions',
      'search_stations',
      'get_stations_by_line',
      'get_incidents',
      'get_elevator_incidents',
      'get_all_stations',
      'get_bus_predictions',
      'get_bus_routes',
      'get_bus_stops',
      'get_bus_positions',
      'get_train_positions',
      'get_station_transfers',
      'get_route_info',
      'search_sfbay_stations',
      'get_sfbay_station_predictions',
      'get_sfbay_routes',
      'get_sfbay_incidents',
      'get_vehicle_positions'
    ]
  };
}
