import { MCP_PROTOCOL_VERSION, SERVER_VERSION } from './config';

export function getServerInfo(baseUrl: string, timestamp = new Date().toISOString()) {
  return {
    name: 'Metro MCP',
    version: SERVER_VERSION,
    description: 'MCP server for US transit systems (DC Metro, NYC Subway)',
    protocolVersion: MCP_PROTOCOL_VERSION,
    status: 'operational',
    timestamp,
    author: 'Anurag Dhungana',
    links: {
      author: 'https://anuragd.me',
      github: 'https://github.com/anuragdhungana/metro-mcp',
      mcpServer: `${baseUrl}/mcp`,
      mcpServerLegacy: `${baseUrl}/sse`,
      website: baseUrl,
      documentation: 'https://github.com/anuragdhungana/metro-mcp/blob/main/README.md',
    },
    capabilities: {
      tools: {
        listChanged: true
      }
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
      }
    ],
    stats: {
      totalStations: 598,
      totalLines: 35,
      citiesSupported: 2,
      toolsAvailable: 13
    },
    endpoints: {
      mcp: ['/mcp', '/sse'],
      mcpRecommended: '/mcp',
      oauth: {
        authorize: '/authorize',
        token: '/token',
        register: '/register'
      },
      discovery: '/.well-known/oauth-authorization-server'
    },
    transport: {
      type: 'streamable-http',
      note: 'MCP Streamable HTTP transport. Sessions live in a Durable Object via cloudflare/agents McpAgent.',
      supportsJSON: true,
      supportsSSEResponses: true,
      supportsServerPush: true,
      supportsResumability: true
    },
    authentication: {
      type: 'OAuth 2.1',
      pkce: true,
      provider: 'GitHub'
    },
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
      'get_route_info'
    ]
  };
}
