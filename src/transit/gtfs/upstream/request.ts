const PROTOBUF_ACCEPT = 'application/x-google-protobuf';

export function buildUpstreamRequest(endpoint: URL, apiKey: string): Request {
  const url = new URL(endpoint);
  url.searchParams.set('api_key', apiKey);
  return new Request(url, {
    headers: { accept: PROTOBUF_ACCEPT },
  });
}

export function redactUpstreamUrl(value: string | URL): string {
  const url = new URL(value);
  if (url.searchParams.has('api_key')) {
    url.searchParams.set('api_key', '[REDACTED]');
  }
  return url.toString();
}
