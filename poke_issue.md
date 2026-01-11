## Poke MCP OAuth Flow Issue

### Summary
Poke completes OAuth authorization and receives an MCP authorization code, but never calls the token endpoint to exchange that code for a JWT. As a result, all subsequent MCP requests are unauthorized.

### Expected Flow (OAuth 2.1 + PKCE)
1) `POST /register` (dynamic client registration)
2) `GET /authorize?response_type=code&client_id=...&code_challenge=...&code_challenge_method=S256&redirect_uri=...&state=...`
3) User authorizes on GitHub, then server redirects back to:
   - `GET /callback?code=...&state=...` (server exchange with GitHub)
4) Server redirects to the client callback with an **MCP auth code**:
   - `https://poke.com/api/v1/mcp/callback?code=<mcp_auth_code>&state=<client_state>`
5) **Client must exchange the MCP auth code** for a JWT:
   - `POST https://metro-mcp.anuragd.me/token`

### Actual Behavior
The flow stops after step 4. There is **no `POST /token`** in Cloudflare logs after the callback redirect.

### Evidence (Cloudflare logs)
Example log sequence:
- `GET https://metro-mcp.anuragd.me/.well-known/oauth-protected-resource/mcp` → 200
- `GET https://metro-mcp.anuragd.me/.well-known/oauth-authorization-server` → 200
- `POST https://metro-mcp.anuragd.me/register` → 200
- `GET https://metro-mcp.anuragd.me/authorize?...` → 200
- `GET https://metro-mcp.anuragd.me/callback?code=...&state=...` → 302
- **No `POST https://metro-mcp.anuragd.me/token`**

### New Finding (Device-Specific)
On mobile (phone), the flow includes the missing token exchange and works end-to-end:
- `POST https://metro-mcp.anuragd.me/token` → 200
- Followed by successful `POST https://metro-mcp.anuragd.me/mcp` calls

On desktop/laptop, the flow stops after `/callback` and never calls `/token`.
This suggests a client-side issue in Poke’s desktop web flow (blocked redirect, JS error, or missing PKCE exchange).

### Required Token Exchange Request
The client must send one of the following:

Form-encoded:
```bash
curl -X POST https://metro-mcp.anuragd.me/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=<mcp_auth_code>" \
  -d "code_verifier=<pkce_verifier>" \
  -d "client_id=<client_id>"
```

JSON:
```bash
curl -X POST https://metro-mcp.anuragd.me/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "<mcp_auth_code>",
    "code_verifier": "<pkce_verifier>",
    "client_id": "<client_id>"
  }'
```

Expected response:
```json
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 7776000
}
```

### Notes
- `code_verifier` must match the original `code_challenge` (S256).
- MCP auth codes are single-use and expire in ~10 minutes.
- Token endpoint supports `token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"]`.

### Impact
Without the `/token` exchange, Poke cannot obtain a JWT and will remain unauthorized when calling `/mcp` or `/sse`.
