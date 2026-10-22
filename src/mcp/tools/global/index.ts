import type { McpServer } from '@modelcontextprotocol/server';
import type { MetroMcpContext } from '../../context';
import { registerFindTool } from './find';
import { registerPlanTool } from './plan';
import { registerDeparturesTool } from './departures';
import { registerServiceStatusTool } from './service-status';
import { registerVehicleStatusTool } from './vehicle-status';

export function registerGlobalTools(server: McpServer, context: MetroMcpContext): void {
  registerFindTool(server, context);
  registerPlanTool(server, context);
  registerDeparturesTool(server, context);
  registerServiceStatusTool(server, context);
  registerVehicleStatusTool(server, context);
}
