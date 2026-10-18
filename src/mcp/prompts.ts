import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

/** Register the three canned transit prompts in wire-visible order. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'service-briefing',
    {
      title: 'Service briefing',
      description: 'Concise briefing on current transit service — full system or a single line.',
      argsSchema: z.object({
        city: z.enum(['dc', 'nyc']).describe('Transit system'),
        lineCode: z.string().optional().describe(
          'Optional specific line (e.g., "RD", "A"). Omit for whole-system.',
        ),
      }),
    },
    ({ city, lineCode }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: lineCode
            ? `Using get_incidents(city: "${city}") and get_stations_by_line(city: "${city}", lineCode: "${lineCode}"), give me a 3-sentence briefing on the ${lineCode} line right now: active incidents, impact, what a commuter should expect.`
            : `Using get_incidents(city: "${city}"), give me a 3-sentence briefing on overall ${city.toUpperCase()} transit service right now.`,
        },
      }],
    }),
  );

  server.registerPrompt(
    'commute-planner',
    {
      title: 'Commute planner',
      description: 'Check planning availability for a commute; return a verified journey where supported or scoped station and service lookups.',
      argsSchema: z.object({
        city: z.enum(['dc', 'nyc']),
        fromStation: z.string().describe('Origin station name'),
        toStation: z.string().describe('Destination station name'),
      }),
    },
    ({ city, fromStation, toStation }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Use find_transit with query "${city}" to inspect coverage. Only if coverage is available and its planning capability is true, use plan_trip with coverage "${city}", origin {query: "${fromStation}"} and destination {query: "${toStation}"}. Report the verified itinerary and its status. Otherwise explain that journey planning is unavailable; use search_stations, get_station_predictions and get_incidents for station departures and service questions. These legacy tools do not provide a full journey planner. Never construct, extend or repair journeys from departures or station predictions.`,
        },
      }],
    }),
  );

  server.registerPrompt(
    'accessibility-check',
    {
      title: 'Accessibility check',
      description: 'Check elevator/escalator status across a route on the DC Metro.',
      argsSchema: z.object({
        stationNames: z.string().describe(
          'Comma-separated DC Metro station names along the route (e.g., "Dupont Circle, Metro Center, Capitol South")',
        ),
      }),
    },
    ({ stationNames }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Using get_elevator_incidents (DC only), check whether any of these stations currently have elevator outages: ${stationNames}. Flag any that do, explain the impact, and suggest alternatives if available.`,
        },
      }],
    }),
  );
}
