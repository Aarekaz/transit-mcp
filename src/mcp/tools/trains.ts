import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getTransitClient } from '../../transit/registry';
import type { WMATAClient } from '../../transit/wmata-client';
import type { MetroMcpContext } from '../context';
import { READ_ONLY_LIVE, complete, withTransitErrors } from '../shared';

/** Register the DC live train positions tool. */
export function registerTrainTools(
  server: McpServer,
  context: MetroMcpContext,
): void {
  server.registerTool(
    'get_train_positions',
    {
      title: 'Live train positions',
      description: 'Get real-time positions of all trains on the DC Metro system.',
      annotations: READ_ONLY_LIVE,
      inputSchema: z.object({}),
      outputSchema: z.object({
        city: z.literal('dc'),
        totalTrains: z.number().int(),
        trains: z.array(z.object({
          trainId: z.string(),
          trainNumber: z.string().nullable(),
          line: z.string().nullable(),
          destination: z.string().nullable(),
          carCount: z.number().int().nullable(),
          direction: z.enum(['Northbound/Eastbound', 'Southbound/Westbound']),
          circuitId: z.number().int().nullable(),
          secondsAtLocation: z.number().int().nullable(),
          serviceType: z.string().nullable(),
        })),
      }),
    },
    async (_args, handlerContext) => withTransitErrors(async () => {
      const signal = handlerContext.mcpReq.signal;
      const trains = await (getTransitClient(
        'dc',
        context.env,
      ) as WMATAClient).getTrainPositions(signal);
      return complete({
        city: 'dc' as const,
        totalTrains: trains.length,
        trains: trains.map(train => ({
          trainId: train.TrainId,
          trainNumber: train.TrainNumber ?? null,
          line: train.LineCode ?? null,
          destination: train.DestinationStationCode ?? null,
          carCount: train.CarCount ?? null,
          direction: (train.DirectionNum === 1
            ? 'Northbound/Eastbound'
            : 'Southbound/Westbound') as
              | 'Northbound/Eastbound'
              | 'Southbound/Westbound',
          circuitId: train.CircuitId ?? null,
          secondsAtLocation: train.SecondsAtLocation ?? null,
          serviceType: train.ServiceType ?? null,
        })),
      });
    }, handlerContext.mcpReq.signal),
  );
}
