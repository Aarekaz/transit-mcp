export type NormalizedMcpRoute = {
  request: Request;
  alias: '/mcp' | '/sse';
};

const ALLOWED_METHODS = new Set(['POST', 'OPTIONS']);

function methodNotAllowed(): Response {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: 'POST, OPTIONS' },
  });
}

/** Admit only the two exact stateless MCP routes before anonymous dispatch. */
export function normalizeMcpRoute(request: Request): NormalizedMcpRoute | Response | undefined {
  const url = new URL(request.url);
  const { pathname } = url;
  const exactAlias = pathname === '/mcp' || pathname === '/sse';
  const broadenedAlias = pathname.startsWith('/mcp/') || pathname.startsWith('/sse/');

  if (broadenedAlias || (exactAlias && !ALLOWED_METHODS.has(request.method.toUpperCase()))) {
    return methodNotAllowed();
  }
  if (!exactAlias) {
    return undefined;
  }
  if (pathname === '/mcp') {
    return { request, alias: '/mcp' };
  }

  url.pathname = '/mcp';
  return {
    request: new Request(url, request),
    alias: '/sse',
  };
}
