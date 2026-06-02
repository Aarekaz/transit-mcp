import { Env } from './types';
import { Router } from './router';

// Export MetroMcpAgent so the wrangler.jsonc DO binding can resolve the class.
// Cloudflare's bundler discovers DO classes by name at deploy time.
export { MetroMcpAgent } from './mcp-agent';

const router = new Router();

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.handleRequest(request, env, ctx);
  }
};
