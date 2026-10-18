import type { McpServer, RequestStateCodec } from '@modelcontextprotocol/server';
import type { MetroMcpContext, TransitRequestState } from '../../context';
import { registerFindTool } from './find';
import { registerPlanTool } from './plan';
import { registerDeparturesTool } from './departures';
import { registerServiceStatusTool } from './service-status';
import { registerVehicleStatusTool } from './vehicle-status';

export function registerGlobalTools(server: McpServer, context: MetroMcpContext, codec: RequestStateCodec<TransitRequestState>): void {
  registerFindTool(server, context);
  registerPlanTool(server, context, codec);
  registerDeparturesTool(server, context);
  registerServiceStatusTool(server, context);
  registerVehicleStatusTool(server, context);
}
