#!/usr/bin/env bash

set -euo pipefail

: "${MCP_CONFORMANCE_TARGET_URL:?MCP_CONFORMANCE_TARGET_URL is required}"
: "${MCP_CONFORMANCE_TOKEN:?MCP_CONFORMANCE_TOKEN is required}"

proxy_port="${MCP_CONFORMANCE_PROXY_PORT:-8788}"
case "$proxy_port" in
  ''|*[!0-9]*)
    echo 'MCP_CONFORMANCE_PROXY_PORT must be numeric' >&2
    exit 1
    ;;
esac

proxy_pid=''
cleanup() {
  if [[ -n "$proxy_pid" ]] && kill -0 "$proxy_pid" 2>/dev/null; then
    kill "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

bun scripts/conformance-auth-proxy.ts &
proxy_pid=$!
unset MCP_CONFORMANCE_TOKEN

proxy_origin="http://127.0.0.1:${proxy_port}"
proxy_ready=0
for _attempt in {1..100}; do
  if curl --fail --silent --max-time 1 "${proxy_origin}/health" >/dev/null 2>&1; then
    proxy_ready=1
    break
  fi
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    wait "$proxy_pid" || true
    echo 'Conformance proxy exited before becoming healthy' >&2
    exit 1
  fi
  sleep 0.1
done

if [[ "$proxy_ready" != '1' ]]; then
  echo 'Conformance proxy did not become healthy' >&2
  exit 1
fi

bunx @modelcontextprotocol/conformance list --requirements 2026-07-28
bunx @modelcontextprotocol/conformance server \
  --url "${proxy_origin}/mcp" \
  --requirements 2026-07-28
