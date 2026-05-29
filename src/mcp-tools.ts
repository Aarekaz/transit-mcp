import { MCPTool, MCPJSONSchema } from './mcp-types';

// Shared sub-schemas reused by multiple tool outputSchemas.
// Inlined (not $ref'd) because client JSON-Schema $ref support varies.
const coordinatesSchema = {
  type: 'object',
  properties: {
    lat: { type: 'number' },
    lon: { type: 'number' }
  },
  required: ['lat', 'lon']
} as const;

const addressSchema = {
  type: ['object', 'null'],
  properties: {
    street: { type: 'string' },
    city: { type: 'string' },
    state: { type: 'string' },
    zip: { type: 'string' }
  }
} as const;

const stationItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    lines: { type: 'array', items: { type: 'string' } },
    coordinates: coordinatesSchema,
    address: addressSchema
  },
  required: ['id', 'name', 'coordinates']
} as const;

// Default annotations for every Metro MCP tool — all are pure live-data reads.
const READ_ONLY_LIVE: MCPTool['annotations'] = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true
};

export const MCP_TOOLS: MCPTool[] = [
  {
    name: 'get_station_predictions',
    title: 'Train arrival predictions',
    description: 'Get real-time train arrival predictions for a transit station. Supports DC Metro and NYC Subway.',
    annotations: READ_ONLY_LIVE,
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc', 'nyc'] },
        station: { type: 'string', description: 'Resolved station ID' },
        predictions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              line: { type: 'string', description: 'Line code (e.g., "RD", "1", "A")' },
              destination: { type: 'string' },
              minutesAway: {
                type: ['integer', 'null'],
                description: 'Minutes until arrival, or null when status is non-numeric (ARRIVING/BOARDING)'
              },
              arrivalStatus: {
                type: 'string',
                enum: ['ARRIVING', 'BOARDING', 'DELAYED', 'SCHEDULED'],
                description: 'Normalized arrival status'
              },
              cars: { type: ['string', 'null'], description: 'Number of cars in train' },
              direction: { type: ['string', 'null'] },
              track: { type: ['string', 'null'] }
            },
            required: ['line', 'destination', 'minutesAway', 'arrivalStatus']
          }
        }
      },
      required: ['city', 'station', 'predictions']
    }
  },
  {
    name: 'search_stations',
    title: 'Search stations',
    description: 'Search for transit stations by name or code. Supports DC Metro and NYC Subway.',
    annotations: READ_ONLY_LIVE,
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc', 'nyc'] },
        query: { type: 'string' },
        results: { type: 'array', items: stationItemSchema }
      },
      required: ['city', 'query', 'results']
    }
  },
  {
    name: 'get_stations_by_line',
    title: 'Stations on a line',
    description: 'Get all stations on a specific transit line. Supports DC Metro and NYC Subway.',
    annotations: READ_ONLY_LIVE,
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc', 'nyc'] },
        line: { type: 'string' },
        stations: { type: 'array', items: stationItemSchema }
      },
      required: ['city', 'line', 'stations']
    }
  },
  {
    name: 'get_incidents',
    title: 'Service incidents',
    description: 'Get current transit incidents and service advisories. Supports DC Metro and NYC Subway.',
    annotations: READ_ONLY_LIVE,
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc', 'nyc'] },
        incidents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              linesAffected: { type: 'array', items: { type: 'string' } },
              severity: { type: 'string', description: 'e.g., "Major", "Minor", "Medium"' },
              type: { type: 'string', description: 'e.g., "Delay", "Alert"' },
              lastUpdated: { type: 'string', description: 'ISO 8601 timestamp' }
            },
            required: ['id', 'description', 'linesAffected', 'severity', 'type', 'lastUpdated']
          }
        }
      },
      required: ['city', 'incidents']
    }
  },
  {
    name: 'get_elevator_incidents',
    title: 'Elevator outages',
    description: 'Get current elevator and escalator outages. DC Metro only.',
    annotations: READ_ONLY_LIVE,
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc'] },
        elevatorIncidents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              stationName: { type: ['string', 'null'] },
              lastUpdated: { type: 'string', description: 'ISO 8601 timestamp' }
            },
            required: ['id', 'description', 'lastUpdated']
          }
        }
      },
      required: ['city', 'elevatorIncidents']
    }
  },
  {
    name: 'get_all_stations',
    title: 'All stations',
    description: 'Get complete list of all transit stations with coordinates. Supports DC Metro and NYC Subway.',
    annotations: READ_ONLY_LIVE,
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc', 'nyc'] },
        totalStations: { type: 'integer' },
        stations: { type: 'array', items: stationItemSchema }
      },
      required: ['city', 'totalStations', 'stations']
    }
  },
  {
    name: 'get_bus_predictions',
    title: 'Bus arrival predictions',
    description: 'Get real-time bus arrival predictions for a DC Metro bus stop. Returns next bus arrivals with route information, direction, and estimated arrival times.',
    annotations: READ_ONLY_LIVE,
    inputSchema: {
      type: 'object',
      properties: {
        stopId: {
          type: 'string',
          description: 'DC Metro 7-digit regional bus stop ID (e.g., "1001195" for Greenbelt Station, "1001582" for Metro Center)'
        }
      },
      required: ['stopId']
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc'] },
        stopId: { type: 'string' },
        predictions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              route: { type: 'string' },
              direction: { type: 'string' },
              minutesAway: { type: 'integer' },
              vehicleId: { type: ['string', 'null'] },
              tripId: { type: ['string', 'null'] }
            },
            required: ['route', 'direction', 'minutesAway']
          }
        }
      },
      required: ['city', 'stopId', 'predictions']
    }
  },
  {
    name: 'get_train_positions',
    title: 'Live train positions',
    description: 'Get real-time positions of all trains currently in service on the DC Metro system. Shows which track circuits trains occupy, car counts, destinations, and service types. Data refreshes every 7-10 seconds.',
    annotations: READ_ONLY_LIVE,
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc'] },
        totalTrains: { type: 'integer' },
        trains: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              trainId: { type: 'string' },
              trainNumber: { type: ['string', 'null'] },
              line: { type: ['string', 'null'] },
              destination: { type: ['string', 'null'] },
              carCount: { type: ['integer', 'null'] },
              direction: { type: 'string', enum: ['Northbound/Eastbound', 'Southbound/Westbound'] },
              circuitId: { type: ['integer', 'null'] },
              secondsAtLocation: { type: ['integer', 'null'] },
              serviceType: { type: ['string', 'null'] }
            },
            required: ['trainId', 'direction']
          }
        }
      },
      required: ['city', 'totalTrains', 'trains']
    }
  },
  {
    name: 'get_bus_routes',
    title: 'All bus routes',
    description: 'Get all DC Metro bus routes with route IDs and descriptions. Returns complete list of bus routes available in the system.',
    annotations: READ_ONLY_LIVE,
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc'] },
        totalRoutes: { type: 'integer' },
        routes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: ['string', 'null'] }
            },
            required: ['id', 'name']
          }
        }
      },
      required: ['city', 'totalRoutes', 'routes']
    }
  },
  {
    name: 'get_bus_stops',
    title: 'Bus stops',
    description: 'Get DC Metro bus stops. Can retrieve all stops or filter by geographic location using latitude, longitude, and optional radius in meters.',
    annotations: READ_ONLY_LIVE,
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc'] },
        totalStops: { type: 'integer' },
        searchLocation: {
          type: ['object', 'null'],
          properties: {
            lat: { type: 'number' },
            lon: { type: 'number' },
            radiusMeters: { type: ['number', 'null'] }
          },
          description: 'Geographic filter applied, or null if returning all stops'
        },
        stops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              coordinates: coordinatesSchema,
              routes: { type: 'array', items: { type: 'string' } }
            },
            required: ['id', 'name', 'coordinates', 'routes']
          }
        }
      },
      required: ['city', 'totalStops', 'stops']
    }
  },
  {
    name: 'get_bus_positions',
    title: 'Live bus positions',
    description: 'Get real-time positions of buses currently in service on DC Metro. Optionally filter by route ID. Data refreshes every 7-10 seconds.',
    annotations: READ_ONLY_LIVE,
    inputSchema: {
      type: 'object',
      properties: {
        routeId: {
          type: 'string',
          description: 'Optional route ID to filter buses (e.g., "30N", "B30"). If omitted, returns all buses in service.'
        }
      },
      required: []
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['dc'] },
        routeFilter: { type: ['string', 'null'], description: 'Route filter applied, or null for all routes' },
        totalBuses: { type: 'integer' },
        buses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              vehicleId: { type: 'string' },
              route: { type: 'string' },
              direction: { type: 'string' },
              coordinates: coordinatesSchema,
              headsign: { type: ['string', 'null'] },
              deviation: { type: ['number', 'null'], description: 'Schedule deviation in minutes (negative = ahead)' },
              lastUpdated: { type: 'string', description: 'ISO 8601 timestamp' }
            },
            required: ['vehicleId', 'route', 'coordinates']
          }
        }
      },
      required: ['city', 'totalBuses', 'buses']
    }
  },
  {
    name: 'get_station_transfers',
    title: 'Station transfers',
    description: 'Get transfer connections and nearby stations from a transit station. Shows walk times between connected stations in the same complex (e.g., Times Square has multiple station IDs connected by walkways). NYC Subway only.',
    annotations: READ_ONLY_LIVE,
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['nyc'] },
        stationId: { type: 'string' },
        stationName: { type: 'string' },
        totalTransfers: { type: 'integer' },
        transfers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              toStationId: { type: 'string' },
              toStationName: { type: 'string' },
              walkTimeSeconds: { type: 'integer' },
              walkTimeMinutes: { type: 'integer', description: 'Rounded up from seconds' },
              transferType: { type: 'string', enum: ['platform', 'nearby'] }
            },
            required: ['toStationId', 'toStationName', 'walkTimeSeconds', 'walkTimeMinutes', 'transferType']
          }
        }
      },
      required: ['city', 'stationId', 'stationName', 'totalTransfers', 'transfers']
    }
  },
  {
    name: 'get_route_info',
    title: 'Route information',
    description: 'Get detailed information about a transit route including service patterns and descriptions. Helps explain what a route like "A train" or "1 train" actually is. NYC Subway only.',
    annotations: READ_ONLY_LIVE,
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
    },
    outputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['nyc'] },
        routeId: { type: 'string' },
        shortName: { type: 'string' },
        longName: { type: 'string' },
        description: { type: 'string' }
      },
      required: ['city', 'routeId', 'shortName', 'longName', 'description']
    }
  }
];

// MCPJSONSchema is re-exported here for tests that want to validate
// tool outputs against the declared schema.
export type { MCPJSONSchema };
