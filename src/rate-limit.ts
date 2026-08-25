export const MCP_RATE_LIMIT = 300;
export const MCP_RATE_LIMIT_PERIOD_SECONDS = 60;

/** Limit anonymous MCP traffic by the Cloudflare-provided client address. */
export async function anonymousMcpRateLimitResponse(
  request: Request,
  limiter: RateLimit,
): Promise<Response | undefined> {
  const key = request.headers.get('CF-Connecting-IP') ?? 'local';
  const outcome = await limiter.limit({ key });
  if (outcome.success) return undefined;

  return Response.json({
    jsonrpc: '2.0',
    error: { code: -32029, message: 'Rate limit exceeded' },
    id: null,
  }, {
    status: 429,
    headers: { 'Retry-After': String(MCP_RATE_LIMIT_PERIOD_SECONDS) },
  });
}
