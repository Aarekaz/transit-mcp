import { MCPRequest, MCPResponse, MCPCapabilities } from './mcp-types';
import { MCP_TOOLS } from './mcp-tools';
import { Env } from './types';
import { validateToolParameters, handleWMATAError } from './error-handler';
import { getTransitClient, isSupportedCity } from './transit/registry';
import { SupportedCity } from './transit/base';
import { WMATAClient } from './transit/wmata-client';

export class MCPHandler {
  async processMCPMethod(request: MCPRequest, env: Env): Promise<MCPResponse> {
    const { method, params = {}, id } = request;
    
    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {
                tools: {
                  listChanged: true
                }
              } as MCPCapabilities,
              serverInfo: {
                name: 'Metro MCP',
                version: '2.8.1'
              }
            }
          };

        case 'notifications/initialized':
          // Client is signaling it has processed the initialize response
          // Per JSON-RPC 2.0, notifications should not receive responses
          // Return a minimal response that the router will handle appropriately
          return {
            jsonrpc: '2.0',
            id: null,
            result: null
          } as MCPResponse;

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: MCP_TOOLS
            }
          };

        case 'tools/call':
          return await this.handleToolCall(params, env, id);

        default:
          throw new Error(`Unknown method: ${method}`);
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Internal error',
          data: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  async handleToolCall(params: any, env: Env, id: string | number): Promise<MCPResponse> {
    const { name: toolName, arguments: args = {} } = params;

    // Validate tool parameters
    try {
      validateToolParameters(toolName, args);
    } catch (validationError) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: 'Invalid params',
          data: validationError instanceof Error ? validationError.message : 'Invalid parameters'
        }
      };
    }

    // Special handling for DC-only and NYC-only tools (city parameter handling)
    const dcOnlyTools = ['get_bus_predictions', 'get_train_positions', 'get_bus_routes', 'get_bus_stops', 'get_bus_positions'];
    const nycOnlyTools = ['get_station_transfers', 'get_route_info'];

    let city: string;
    if (dcOnlyTools.includes(toolName)) {
      city = 'dc';
    } else if (nycOnlyTools.includes(toolName)) {
      city = args.city || 'nyc'; // Default to nyc for these tools
    } else {
      city = args.city as string;
    }

    // Validate city parameter for tools that require it
    if (!dcOnlyTools.includes(toolName)) {
      if (!city || !isSupportedCity(city)) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: 'Invalid params',
            data: `Unsupported city: ${city}. Supported cities: dc, nyc`
          }
        };
      }
    }

    // Get transit client for the specified city
    let client;
    try {
      client = getTransitClient(city as SupportedCity, env);
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: 'Invalid params',
          data: error instanceof Error ? error.message : 'Failed to initialize transit client'
        }
      };
    }

    try {
      let result;

      switch (toolName) {
        case 'get_station_predictions': {
          const stationName = args.stationName as string;

          // Auto-convert station name to ID
          let stationId: string;
          // Check if it's already a station code (DC: letter + 2 digits, NYC: numeric)
          if (/^[A-Z]\d{2}$/i.test(stationName)) {
            // DC station code format
            stationId = stationName.toUpperCase();
          } else if (/^\d+[NS]?$/.test(stationName)) {
            // NYC station ID format
            stationId = stationName;
          } else {
            // Search for station by name
            const searchResults = await client.searchStation(stationName);
            if (searchResults.length === 0) {
              throw new Error(`No station found matching: ${stationName}`);
            }
            stationId = searchResults[0]!.id;
          }

          const predictions = await client.getStationPredictions(stationId);
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city,
                  station: stationId,
                  predictions: predictions.map(p => ({
                    line: p.line,
                    destination: p.destination,
                    minutes: typeof p.minutesAway === 'string'
                      ? p.minutesAway
                      : `${p.minutesAway} min`,
                    cars: p.cars,
                    direction: p.direction,
                    track: p.track
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'search_stations': {
          const query = args.query as string;
          const stations = await client.searchStation(query);
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city,
                  query,
                  results: stations.map(s => ({
                    id: s.id,
                    name: s.name,
                    lines: s.lines,
                    coordinates: { lat: s.latitude, lon: s.longitude },
                    address: s.address
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_stations_by_line': {
          const lineCode = args.lineCode as string;
          const lineStations = await client.getStationsByLine(lineCode);
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city,
                  line: lineCode,
                  stations: lineStations.map(s => ({
                    id: s.id,
                    name: s.name,
                    coordinates: { lat: s.latitude, lon: s.longitude },
                    address: s.address
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_incidents': {
          const incidents = await client.getIncidents();
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city,
                  incidents: incidents.map(i => ({
                    id: i.incidentId,
                    description: i.description,
                    linesAffected: i.linesAffected,
                    severity: i.severity,
                    type: i.incidentType,
                    lastUpdated: i.timestamp
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_elevator_incidents': {
          // Elevator incidents only supported for DC
          if (city !== 'dc') {
            throw new Error('Elevator incidents are only supported for DC Metro');
          }
          const wmataClient = client as WMATAClient;
          const elevatorIncidents = await wmataClient.getElevatorIncidents();
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city,
                  elevatorIncidents: elevatorIncidents.map(i => ({
                    id: i.incidentId,
                    description: i.description,
                    stationName: i.startLocation || i.endLocation,
                    lastUpdated: i.timestamp
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_all_stations': {
          const allStations = await client.getStations();
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city,
                  totalStations: allStations.length,
                  stations: allStations.map(s => ({
                    id: s.id,
                    name: s.name,
                    lines: s.lines,
                    coordinates: { lat: s.latitude, lon: s.longitude },
                    address: s.address
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_bus_predictions': {
          // Bus predictions only supported for DC
          const wmataClient = client as WMATAClient;
          const stopId = args.stopId as string;
          const busPredictions = await wmataClient.getBusPredictions(stopId);
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city: 'dc',
                  stopId,
                  predictions: busPredictions.map(p => ({
                    route: p.RouteID,
                    direction: p.DirectionText,
                    minutes: p.Minutes,
                    vehicleId: p.VehicleID,
                    tripId: p.TripID
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_train_positions': {
          // Train positions only supported for DC
          const wmataClient = client as WMATAClient;
          const trainPositions = await wmataClient.getTrainPositions();
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city: 'dc',
                  totalTrains: trainPositions.length,
                  trains: trainPositions.map(t => ({
                    trainId: t.TrainId,
                    trainNumber: t.TrainNumber,
                    line: t.LineCode,
                    destination: t.DestinationStationCode,
                    carCount: t.CarCount,
                    direction: t.DirectionNum === 1 ? 'Northbound/Eastbound' : 'Southbound/Westbound',
                    circuitId: t.CircuitId,
                    secondsAtLocation: t.SecondsAtLocation,
                    serviceType: t.ServiceType
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_bus_routes': {
          // List all bus routes
          const wmataClient = client as WMATAClient;
          const busRoutes = await wmataClient.getBusRoutes();
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city: 'dc',
                  totalRoutes: busRoutes.length,
                  routes: busRoutes.map(r => ({
                    id: r.RouteID,
                    name: r.Name,
                    description: r.LineDescription
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_bus_stops': {
          // Get bus stops (all or filtered by location)
          const wmataClient = client as WMATAClient;
          const { latitude, longitude, radius } = args;
          const busStops = await wmataClient.getBusStops(
            latitude as number | undefined,
            longitude as number | undefined,
            radius as number | undefined
          );
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city: 'dc',
                  totalStops: busStops.length,
                  searchLocation: latitude !== undefined && longitude !== undefined
                    ? { lat: latitude, lon: longitude, radiusMeters: radius }
                    : 'all stops',
                  stops: busStops.map(s => ({
                    id: s.StopID,
                    name: s.Name,
                    coordinates: { lat: s.Lat, lon: s.Lon },
                    routes: s.Routes
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_bus_positions': {
          // Get real-time bus positions
          const wmataClient = client as WMATAClient;
          const { routeId } = args;
          const busPositions = await wmataClient.getBusPositions(routeId as string | undefined);
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city: 'dc',
                  routeFilter: routeId || 'all routes',
                  totalBuses: busPositions.length,
                  buses: busPositions.map(b => ({
                    vehicleId: b.VehicleID,
                    route: b.RouteID,
                    direction: b.DirectionText,
                    coordinates: { lat: b.Lat, lon: b.Lon },
                    headsign: b.TripHeadsign,
                    deviation: b.Deviation,
                    lastUpdated: b.DateTime
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_station_transfers': {
          const stationId = args.stationId as string;

          // Get station transfers (NYC only for now)
          const station = (await client.getStations()).find(s => s.id === stationId);
          if (!station) {
            throw new Error(`Station not found: ${stationId}`);
          }

          const transfers = station.transfers || [];
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city,
                  stationId,
                  stationName: station.name,
                  totalTransfers: transfers.length,
                  transfers: transfers.map(t => ({
                    toStationId: t.toStationId,
                    toStationName: t.toStationName,
                    walkTimeSeconds: t.transferTime,
                    walkTimeMinutes: Math.ceil(t.transferTime / 60),
                    transferType: t.transferType
                  }))
                }, null, 2)
              }
            ]
          };
          break;
        }

        case 'get_route_info': {
          const routeId = args.routeId as string;
          const route = await client.getRouteInfo(routeId);

          if (!route) {
            throw new Error(`Route not found: ${routeId}. Make sure you're using the correct route ID for ${city}.`);
          }

          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  city,
                  routeId: route.routeId,
                  shortName: route.shortName,
                  longName: route.longName,
                  description: route.description
                }, null, 2)
              }
            ]
          };
          break;
        }

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      return {
        jsonrpc: '2.0',
        id,
        result
      };
    } catch (error) {
      // Provide more specific error codes based on the error type
      let errorCode = -32603; // Default internal error
      let errorMessage = 'Internal error';

      if (error instanceof Error) {
        if (error.message.includes('401') || error.message.includes('Access denied')) {
          errorCode = -32602;
          errorMessage = 'Invalid params';
        } else if (error.message.includes('400') || error.message.includes('Bad Request')) {
          errorCode = -32602;
          errorMessage = 'Invalid params';
        } else if (error.message.includes('404') || error.message.includes('Not Found')) {
          errorCode = -32601;
          errorMessage = 'Method not found';
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: errorCode,
          message: errorMessage,
          data: handleWMATAError(error)
        }
      };
    }
  }
}