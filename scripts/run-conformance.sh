#!/usr/bin/env bash
set -euo pipefail
: "${MCP_CONFORMANCE_TARGET_URL:?MCP_CONFORMANCE_TARGET_URL is required}"
bunx @modelcontextprotocol/conformance list --requirements 2026-07-28
bunx @modelcontextprotocol/conformance server \
  --url "$MCP_CONFORMANCE_TARGET_URL" \
  --requirements 2026-07-28
