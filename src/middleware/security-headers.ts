/**
 * Security Headers Middleware
 * 
 * SECURITY PHILOSOPHY:
 * "Defense in depth" - Multiple layers of security headers protect against
 * different attack vectors. Even if one fails, others provide protection.
 * 
 * WHY SEPARATE MODULE:
 * - Centralized security policy management
 * - Easy to audit and update
 * - Consistent headers across all responses
 * - Testable in isolation
 * 
 * REFERENCES:
 * - OWASP Secure Headers Project: https://owasp.org/www-project-secure-headers/
 * - MDN Web Security: https://developer.mozilla.org/en-US/docs/Web/Security
 * - Content Security Policy: https://content-security-policy.com/
 */

/**
 * Response context determines which security headers to apply
 * 
 * WHY DIFFERENT CONTEXTS:
 * - HTML pages need different CSP than JSON API responses
 * - OAuth flows need inline scripts, APIs don't
 * - Static content can use stricter policies
 */
export type ResponseContext = 
  | 'html'        // HTML pages (OAuth callbacks)
  | 'json'        // JSON responses (MCP API, error responses)
  | 'static'      // Static content (images, CSS)
  | 'stream';     // SSE streams

/**
 * Content Security Policy (CSP) configurations
 * 
 * CSP EXPLAINED:
 * Controls what resources the browser can load for a page.
 * Prevents XSS attacks by blocking inline scripts and untrusted sources.
 * 
 * DIRECTIVES:
 * - default-src: Fallback for all resource types
 * - script-src: JavaScript sources
 * - style-src: CSS sources
 * - img-src: Image sources
 * - connect-src: AJAX, WebSocket, EventSource sources
 * - frame-ancestors: Who can embed this page in frames
 * - base-uri: Restricts <base> tag URLs
 * - form-action: Where forms can submit to
 */
const CSP_POLICIES: Record<ResponseContext, string> = {
  /**
   * HTML context (OAuth callbacks)
   * 
   * WHY 'unsafe-inline' FOR SCRIPTS:
   * OAuth callback pages need inline scripts to:
   * 1. Extract authorization code from URL
   * 2. Display the code to the user
   * 3. Handle the OAuth flow completion
   * 
   * SECURITY TRADEOFF:
   * We accept 'unsafe-inline' for OAuth pages because:
   * - These pages are generated server-side
   * - No user-controlled content is rendered
   * - The inline scripts are minimal and audited
   * - Alternative (nonces) would complicate deployment
   * 
   * MITIGATION:
   * - OAuth pages don't accept user input
   * - Scripts are static and reviewed
   * - frame-ancestors prevents clickjacking
   */
  html: [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",  // Allow inline scripts for OAuth
    "style-src 'self' 'unsafe-inline'",   // Allow inline styles
    "img-src 'self' data:",               // Allow images from same origin and data URIs
    "connect-src 'self'",                 // Allow AJAX to same origin
    "frame-ancestors 'none'",             // Prevent embedding in frames
    "base-uri 'self'",                    // Restrict <base> tag
    "form-action 'self'"                  // Forms can only submit to same origin
  ].join('; '),

  /**
   * JSON context (MCP API)
   * 
   * WHY STRICTEST POLICY:
   * JSON responses are never rendered in browsers, so we can use
   * the strictest possible CSP. This provides maximum protection
   * if a response is somehow rendered as HTML.
   * 
   * 'none' FOR EVERYTHING:
   * - No scripts can run
   * - No styles can apply
   * - No resources can load
   * - No frames can embed
   * 
   * DEFENSE IN DEPTH:
   * Even though JSON shouldn't be rendered, this CSP protects
   * against MIME confusion attacks where a JSON response is
   * incorrectly interpreted as HTML.
   */
  json: [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'none'",
    "img-src 'none'",
    "connect-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; '),

  /**
   * Static context (images, CSS, etc.)
   * 
   * WHY THIS POLICY:
   * Static content should only load resources, not execute scripts
   */
  static: [
    "default-src 'none'",
    "img-src 'self'",
    "style-src 'self'",
    "frame-ancestors 'none'"
  ].join('; '),

  /**
   * Stream context (SSE)
   * 
   * WHY DIFFERENT:
   * SSE streams are event sources, need connect-src
   */
  stream: [
    "default-src 'none'",
    "connect-src 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

/**
 * Additional security headers
 * 
 * These headers are applied to all responses regardless of context
 * because they provide fundamental security protections.
 */
const SECURITY_HEADERS = {
  /**
   * X-Content-Type-Options: nosniff
   * 
   * WHY NEEDED:
   * Prevents browsers from MIME-sniffing responses away from
   * declared Content-Type. Without this, a JSON file could be
   * interpreted as HTML if it looks like HTML.
   * 
   * ATTACK PREVENTION:
   * - Prevents JSON responses being rendered as HTML
   * - Stops CSS files being executed as JavaScript
   * - Blocks image files being interpreted as HTML
   * 
   * EXAMPLE ATTACK:
   * Attacker uploads "image.jpg" that contains HTML/JavaScript.
   * Without nosniff, browser might execute it as HTML.
   * With nosniff, browser strictly treats it as image/jpeg.
   */
  'X-Content-Type-Options': 'nosniff',

  /**
   * X-Frame-Options: DENY
   * 
   * WHY NEEDED:
   * Prevents the page from being embedded in frames/iframes.
   * Protects against clickjacking attacks.
   * 
   * CLICKJACKING EXPLAINED:
   * Attacker embeds your site in invisible iframe, tricks user
   * into clicking on hidden buttons (e.g., "Authorize" button).
   * 
   * WHY DENY:
   * This service doesn't need to be embedded anywhere.
   * If embedding was needed, we'd use SAMEORIGIN.
   * 
   * MODERN ALTERNATIVE:
   * CSP frame-ancestors is newer, but X-Frame-Options provides
   * compatibility with older browsers.
   */
  'X-Frame-Options': 'DENY',

  /**
   * Referrer-Policy: strict-origin-when-cross-origin
   * 
   * WHY THIS POLICY:
   * Balances privacy with functionality:
   * - Same-origin: Full URL in referrer (needed for OAuth)
   * - Cross-origin HTTPS: Only send origin, not full URL
   * - Cross-origin HTTP: No referrer (protect against downgrade)
   * 
   * PRIVACY BENEFIT:
   * Prevents leaking sensitive URL parameters to third parties.
   * Example: /callback?code=secret doesn't leak 'secret' to other sites.
   * 
   * ALTERNATIVES CONSIDERED:
   * - no-referrer: Too strict, breaks OAuth flows
   * - same-origin: Good but doesn't handle cross-origin well
   * - strict-origin-when-cross-origin: Best balance (CHOSEN)
   */
  'Referrer-Policy': 'strict-origin-when-cross-origin',

  /**
   * Permissions-Policy
   * 
   * WHY NEEDED:
   * Disables browser features this application doesn't use.
   * Reduces attack surface and prevents abuse.
   * 
   * FEATURES DISABLED:
   * - geolocation: No need to track user location
   * - microphone: No audio recording
   * - camera: No video/photo capture
   * - payment: No payment processing
   * - usb: No USB device access
   * 
   * SECURITY BENEFIT:
   * If XSS vulnerability exists, attacker can't abuse these features.
   * Defense in depth - limits damage even if other protections fail.
   * 
   * FORMAT:
   * feature=(allowed-origins)
   * () = disabled for all origins
   * (self) = allowed for same origin only
   */
  'Permissions-Policy': [
    'geolocation=()',
    'microphone=()',
    'camera=()',
    'payment=()',
    'usb=()'
  ].join(', '),

  /**
   * X-XSS-Protection: 0
   * 
   * WHY DISABLED:
   * Modern browsers have deprecated this header in favor of CSP.
   * The feature had security issues and could be abused.
   * 
   * HISTORY:
   * - Old browsers used this for XSS filtering
   * - Researchers found it could be exploited
   * - Modern approach: Use CSP instead (which we do)
   * 
   * SETTING TO 0:
   * Explicitly disables it to prevent any issues in old browsers
   * that might still support it.
   */
  'X-XSS-Protection': '0'
} as const;

/**
 * CORS headers for cross-origin requests
 * 
 * WHY NEEDED:
 * MCP clients (like Claude Desktop) may run from different origins.
 * We need CORS headers to allow legitimate cross-origin requests.
 * 
 * SECURITY NOTE:
 * We allow all origins (*) because:
 * 1. Authentication via OAuth + JWT provides real security
 * 2. MCP protocol requires cross-origin access
 * 3. Public API doesn't have CSRF concerns (uses Bearer tokens)
 * 
 * IF WE USED COOKIES:
 * We would need to restrict origins and set credentials: true
 * But we use Bearer tokens, so * is safe.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'  // 24 hours cache for preflight
} as const;

/**
 * Apply security headers to a response
 * 
 * @param response - Response to add headers to
 * @param context - Response context (determines CSP policy)
 * @param includeCors - Whether to include CORS headers
 * @returns Response with security headers added
 * 
 * USAGE:
 * ```typescript
 * // For JSON API responses
 * const response = new Response(JSON.stringify(data));
 * return addSecurityHeaders(response, 'json', true);
 * 
 * // For HTML OAuth callback
 * const response = new Response(html, { headers: { 'Content-Type': 'text/html' } });
 * return addSecurityHeaders(response, 'html', false);
 * ```
 * 
 * WHY NEW RESPONSE OBJECT:
 * Response headers are immutable in Workers runtime.
 * We create a new Response with updated headers.
 */
export function addSecurityHeaders(
  response: Response,
  context: ResponseContext = 'json',
  includeCors: boolean = true
): Response {
  // Clone headers to avoid mutating original
  const headers = new Headers(response.headers);

  // Add context-specific CSP
  headers.set('Content-Security-Policy', CSP_POLICIES[context]);

  // Add universal security headers
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => {
    headers.set(key, value);
  });

  // Add CORS headers if requested
  if (includeCors) {
    Object.entries(CORS_HEADERS).forEach(([key, value]) => {
      headers.set(key, value);
    });
  }

  // Create new response with updated headers
  // WHY: Response objects are immutable in Workers runtime
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Detect response context from Content-Type header
 * 
 * WHY AUTOMATIC DETECTION:
 * Makes it easier to use - caller doesn't need to specify context
 * if it's obvious from Content-Type.
 * 
 * USAGE:
 * ```typescript
 * const context = detectResponseContext(response);
 * return addSecurityHeaders(response, context);
 * ```
 */
export function detectResponseContext(response: Response): ResponseContext {
  const contentType = response.headers.get('Content-Type')?.toLowerCase();

  if (!contentType) {
    return 'json';  // Default to JSON (most restrictive)
  }

  if (contentType.includes('text/html')) {
    return 'html';
  }

  if (contentType.includes('application/json')) {
    return 'json';
  }

  if (contentType.includes('text/event-stream')) {
    return 'stream';
  }

  if (contentType.includes('image/') || contentType.includes('text/css')) {
    return 'static';
  }

  return 'json';  // Default to most restrictive
}

/**
 * Convenience function: Detect context and apply headers
 * 
 * USAGE:
 * ```typescript
 * const response = new Response(html, { headers: { 'Content-Type': 'text/html' } });
 * return addSecurityHeadersAuto(response);
 * // Automatically detects 'html' context from Content-Type
 * ```
 */
export function addSecurityHeadersAuto(
  response: Response,
  includeCors: boolean = true
): Response {
  const context = detectResponseContext(response);
  return addSecurityHeaders(response, context, includeCors);
}

/**
 * Create a secure JSON response
 * 
 * CONVENIENCE FUNCTION:
 * Creates a JSON response with proper headers in one call
 * 
 * USAGE:
 * ```typescript
 * return createSecureJsonResponse({ status: 'ok' });
 * ```
 */
export function createSecureJsonResponse(
  data: any,
  status: number = 200,
  additionalHeaders?: Record<string, string>
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...additionalHeaders
  };

  const response = new Response(
    JSON.stringify(data),
    { status, headers }
  );

  return addSecurityHeaders(response, 'json', true);
}

/**
 * Create a secure HTML response
 * 
 * CONVENIENCE FUNCTION:
 * Creates an HTML response with proper headers in one call
 * 
 * USAGE:
 * ```typescript
 * return createSecureHtmlResponse('<html>...</html>');
 * ```
 */
export function createSecureHtmlResponse(
  html: string,
  status: number = 200,
  additionalHeaders?: Record<string, string>
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    ...additionalHeaders
  };

  const response = new Response(
    html,
    { status, headers }
  );

  return addSecurityHeaders(response, 'html', false);
}
