export interface ConformanceProxyEnvironment {
  MCP_CONFORMANCE_TARGET_URL?: string;
  MCP_CONFORMANCE_TOKEN?: string;
  MCP_CONFORMANCE_PROXY_PORT?: string;
  MCP_CONFORMANCE_ALLOW_REMOTE?: string;
}

export interface ConformanceProxyOptions {
  target: URL;
  token: string;
  port: number;
}

type FetchUpstream = (request: Request) => Promise<Response>;

interface BunServer {
  readonly hostname: string;
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
}

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch(request: Request): Promise<Response>;
  }): BunServer;
};

export function requireAbsoluteHttpUrl(value: string, allowRemote: boolean): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error('MCP_CONFORMANCE_TARGET_URL must be an absolute HTTP(S) URL');
  }

  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('MCP_CONFORMANCE_TARGET_URL must be an absolute HTTP(S) URL without credentials');
  }

  const hostname = target.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]';
  if (!isLoopback && !allowRemote) {
    throw new Error(
      'Refusing non-loopback conformance target; set MCP_CONFORMANCE_ALLOW_REMOTE=1 explicitly',
    );
  }

  return target;
}

export function loadConformanceProxyOptions(
  environment: ConformanceProxyEnvironment,
): ConformanceProxyOptions {
  if (!environment.MCP_CONFORMANCE_TARGET_URL?.trim()) {
    throw new Error('MCP_CONFORMANCE_TARGET_URL is required');
  }
  if (!environment.MCP_CONFORMANCE_TOKEN?.trim()) {
    throw new Error('MCP_CONFORMANCE_TOKEN is required');
  }

  const portText = environment.MCP_CONFORMANCE_PROXY_PORT ?? '8788';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('MCP_CONFORMANCE_PROXY_PORT must be an integer from 1 to 65535');
  }

  return {
    target: requireAbsoluteHttpUrl(
      environment.MCP_CONFORMANCE_TARGET_URL,
      environment.MCP_CONFORMANCE_ALLOW_REMOTE === '1',
    ),
    token: environment.MCP_CONFORMANCE_TOKEN,
    port,
  };
}

export function createConformanceProxyHandler(
  target: URL,
  token: string,
  fetchUpstream: FetchUpstream = fetch,
): (request: Request) => Promise<Response> {
  return async request => {
    const incomingUrl = new URL(request.url);
    if (incomingUrl.pathname === '/health') {
      return new Response('ok', {
        headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, target.origin);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('connection');
    headers.delete('content-length');
    headers.delete('host');
    headers.delete('transfer-encoding');
    headers.set('authorization', `Bearer ${token}`);

    const body = ['GET', 'HEAD'].includes(request.method)
      ? undefined
      : await request.arrayBuffer();
    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });

    try {
      return await fetchUpstream(upstreamRequest);
    } catch {
      return new Response('Bad Gateway', {
        status: 502,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
        },
      });
    }
  };
}

export function startConformanceProxy(options: ConformanceProxyOptions): BunServer {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    fetch: createConformanceProxyHandler(options.target, options.token),
  });
}

if (import.meta.main) {
  try {
    const options = loadConformanceProxyOptions({
      MCP_CONFORMANCE_TARGET_URL: process.env.MCP_CONFORMANCE_TARGET_URL,
      MCP_CONFORMANCE_TOKEN: process.env.MCP_CONFORMANCE_TOKEN,
      MCP_CONFORMANCE_PROXY_PORT: process.env.MCP_CONFORMANCE_PROXY_PORT,
      MCP_CONFORMANCE_ALLOW_REMOTE: process.env.MCP_CONFORMANCE_ALLOW_REMOTE,
    });
    const server = startConformanceProxy(options);
    console.log(`Conformance proxy listening on http://${server.hostname}:${server.port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to start conformance proxy');
    process.exitCode = 1;
  }
}
