import { MCPTool } from './mcp-types';

export const MCP_TOOLS: MCPTool[] = [
  {
    name: 'get_station_predictions',
    description: 'Get real-time train arrival predictions for a transit station. Supports DC Metro and NYC Subway.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          enum: ['dc', 'nyc'],
          description: 'Transit system: "dc" for Washington DC Metro, "nyc" for NYC Subway'
        },
        stationName: {
          type: 'string',
          description: 'Station name (e.g., "Metro Center", "Times Square") - will be auto-converted to station ID. For DC you can also use station codes like "A01".'
        }
      },
      required: ['city', 'stationName']
    }
  },
  {
    name: 'search_stations',
    description: 'Search for transit stations by name or code. Supports DC Metro and NYC Subway.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          enum: ['dc', 'nyc'],
          description: 'Transit system: "dc" for Washington DC Metro, "nyc" for NYC Subway'
        },
        query: {
          type: 'string',
          description: 'Search query (station name or code, e.g., "Union", "127", "Dupont")'
        }
      },
      required: ['city', 'query']
    }
  },
  {
    name: 'get_stations_by_line',
    description: 'Get all stations on a specific transit line. Supports DC Metro and NYC Subway.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          enum: ['dc', 'nyc'],
          description: 'Transit system: "dc" for Washington DC Metro, "nyc" for NYC Subway'
        },
        lineCode: {
          type: 'string',
          description: 'Line code - DC: RD, BL, YL, OR, GR, SV | NYC: 1, 2, 3, 4, 5, 6, 7, A, C, E, B, D, F, M, N, Q, R, W, J, Z, L, G, SI'
        }
      },
      required: ['city', 'lineCode']
    }
  },
  {
    name: 'get_incidents',
    description: 'Get current transit incidents and service advisories. Supports DC Metro and NYC Subway.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          enum: ['dc', 'nyc'],
          description: 'Transit system: "dc" for Washington DC Metro, "nyc" for NYC Subway'
        }
      },
      required: ['city']
    }
  },
  {
    name: 'get_elevator_incidents',
    description: 'Get current elevator and escalator outages. DC Metro only.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          enum: ['dc'],
          description: 'Transit system: only "dc" is supported for elevator incidents'
        }
      },
      required: ['city']
    }
  },
  {
    name: 'get_all_stations',
    description: 'Get complete list of all transit stations with coordinates. Supports DC Metro and NYC Subway.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          enum: ['dc', 'nyc'],
          description: 'Transit system: "dc" for Washington DC Metro, "nyc" for NYC Subway'
        }
      },
      required: ['city']
    }
  },
  {
    name: 'get_bus_predictions',
    description: 'Get real-time bus arrival predictions for a DC Metro bus stop. Returns next bus arrivals with route information, direction, and estimated arrival times.',
    inputSchema: {
      type: 'object',
      properties: {
        stopId: {
          type: 'string',
          description: 'DC Metro 7-digit regional bus stop ID (e.g., "1001195" for Greenbelt Station, "1001582" for Metro Center)'
        }
      },
      required: ['stopId']
    }
  },
  {
    name: 'get_train_positions',
    description: 'Get real-time positions of all trains currently in service on the DC Metro system. Shows which track circuits trains occupy, car counts, destinations, and service types. Data refreshes every 7-10 seconds.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_bus_routes',
    description: 'Get all DC Metro bus routes with route IDs and descriptions. Returns complete list of bus routes available in the system.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_bus_stops',
    description: 'Get DC Metro bus stops. Can retrieve all stops or filter by geographic location using latitude, longitude, and optional radius in meters.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: {
          type: 'number',
          description: 'Center point latitude for location-based search (e.g., 38.8951 for Dupont Circle)'
        },
        longitude: {
          type: 'number',
          description: 'Center point longitude for location-based search (e.g., -77.0369 for Dupont Circle)'
        },
        radius: {
          type: 'number',
          description: 'Search radius in meters when using lat/lon (e.g., 500 for half-kilometer). Optional.'
        }
      },
      required: []
    }
  },
  {
    name: 'get_bus_positions',
    description: 'Get real-time positions of buses currently in service on DC Metro. Optionally filter by route ID. Data refreshes every 7-10 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        routeId: {
          type: 'string',
          description: 'Optional route ID to filter buses (e.g., "30N", "B30"). If omitted, returns all buses in service.'
        }
      },
      required: []
    }
  },
  {
    name: 'get_station_transfers',
    description: 'Get transfer connections and nearby stations from a transit station. Shows walk times between connected stations in the same complex (e.g., Times Square has multiple station IDs connected by walkways). NYC Subway only.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          enum: ['nyc'],
          description: 'Transit system: only "nyc" is currently supported for transfer information'
        },
        stationId: {
          type: 'string',
          description: 'Station ID (e.g., "127" for Times Square). Use search_stations to find station IDs.'
        }
      },
      required: ['city', 'stationId']
    }
  },
  {
    name: 'get_route_info',
    description: 'Get detailed information about a transit route including service patterns and descriptions. Helps explain what a route like "A train" or "1 train" actually is. NYC Subway only.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          enum: ['nyc'],
          description: 'Transit system: only "nyc" is currently supported for route information'
        },
        routeId: {
          type: 'string',
          description: 'Route identifier - NYC: A, B, C, D, E, F, M, G, J, Z, L, N, Q, R, W, 1, 2, 3, 4, 5, 6, 7, SI'
        }
      },
      required: ['city', 'routeId']
    }
  }
];