/**
 * Security Headers Tests
 * 
 * WHY THESE TESTS:
 * Security headers are our first line of defense against web attacks.
 * These tests verify:
 * 1. All required headers are present
 * 2. CSP policies are context-appropriate
 * 3. Headers have correct values
 * 4. Auto-detection works correctly
 */

import { describe, it, expect } from 'vitest';
import {
  addSecurityHeaders,
  detectResponseContext,
  addSecurityHeadersAuto,
  createSecureJsonResponse,
  createSecureHtmlResponse,
} from '../../src/middleware/security-headers';

describe('Security Headers', () => {
  describe('addSecurityHeaders', () => {
    it('should add CSP header for JSON context', () => {
      const response = new Response('{}');
      const secured = addSecurityHeaders(response, 'json');

      const csp = secured.headers.get('Content-Security-Policy');
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'none'");
    });

    it('should add CSP header for HTML context', () => {
      const response = new Response('<html></html>');
      const secured = addSecurityHeaders(response, 'html');

      const csp = secured.headers.get('Content-Security-Policy');
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    });

    it('should add X-Content-Type-Options header', () => {
      const response = new Response('test');
      const secured = addSecurityHeaders(response, 'json');

      expect(secured.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('should add X-Frame-Options header', () => {
      const response = new Response('test');
      const secured = addSecurityHeaders(response, 'json');

      expect(secured.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('should add Referrer-Policy header', () => {
      const response = new Response('test');
      const secured = addSecurityHeaders(response, 'json');

      expect(secured.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });

    it('should add Permissions-Policy header', () => {
      const response = new Response('test');
      const secured = addSecurityHeaders(response, 'json');

      const policy = secured.headers.get('Permissions-Policy');
      expect(policy).toContain('geolocation=()');
      expect(policy).toContain('microphone=()');
      expect(policy).toContain('camera=()');
    });

    it('should add CORS headers when requested', () => {
      const response = new Response('test');
      const secured = addSecurityHeaders(response, 'json', true);

      expect(secured.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(secured.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });

    it('should not add CORS headers when not requested', () => {
      const response = new Response('test');
      const secured = addSecurityHeaders(response, 'json', false);

      expect(secured.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('should preserve original response body', async () => {
      const body = JSON.stringify({ test: 'data' });
      const response = new Response(body);
      const secured = addSecurityHeaders(response, 'json');

      const securedBody = await secured.text();
      expect(securedBody).toBe(body);
    });

    it('should preserve original status code', () => {
      const response = new Response('test', { status: 404 });
      const secured = addSecurityHeaders(response, 'json');

      expect(secured.status).toBe(404);
    });
  });

  describe('detectResponseContext', () => {
    it('should detect HTML context', () => {
      const response = new Response('<html></html>', {
        headers: { 'Content-Type': 'text/html' }
      });
      expect(detectResponseContext(response)).toBe('html');
    });

    it('should detect JSON context', () => {
      const response = new Response('{}', {
        headers: { 'Content-Type': 'application/json' }
      });
      expect(detectResponseContext(response)).toBe('json');
    });

    it('should detect stream context', () => {
      const response = new Response('', {
        headers: { 'Content-Type': 'text/event-stream' }
      });
      expect(detectResponseContext(response)).toBe('stream');
    });

    it('should detect static context for images', () => {
      const response = new Response('', {
        headers: { 'Content-Type': 'image/png' }
      });
      expect(detectResponseContext(response)).toBe('static');
    });

    it('should default to JSON for unknown types', () => {
      const response = new Response('test');
      expect(detectResponseContext(response)).toBe('json');
    });
  });

  describe('addSecurityHeadersAuto', () => {
    it('should automatically detect and apply headers', () => {
      const response = new Response('{}', {
        headers: { 'Content-Type': 'application/json' }
      });
      const secured = addSecurityHeadersAuto(response);

      const csp = secured.headers.get('Content-Security-Policy');
      expect(csp).toContain("script-src 'none'");
    });
  });

  describe('createSecureJsonResponse', () => {
    it('should create a secure JSON response', async () => {
      const data = { test: 'value' };
      const response = createSecureJsonResponse(data);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.headers.get('Content-Security-Policy')).toBeTruthy();

      const body = await response.json();
      expect(body).toEqual(data);
    });

    it('should support custom status codes', () => {
      const response = createSecureJsonResponse({ error: 'not found' }, 404);
      expect(response.status).toBe(404);
    });

    it('should support additional headers', () => {
      const response = createSecureJsonResponse(
        { test: 'value' },
        200,
        { 'X-Custom-Header': 'custom-value' }
      );
      expect(response.headers.get('X-Custom-Header')).toBe('custom-value');
    });
  });

  describe('createSecureHtmlResponse', () => {
    it('should create a secure HTML response', async () => {
      const html = '<html><body>Test</body></html>';
      const response = createSecureHtmlResponse(html);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      expect(response.headers.get('Content-Security-Policy')).toBeTruthy();

      const body = await response.text();
      expect(body).toBe(html);
    });

    it('should allow inline scripts for OAuth', () => {
      const response = createSecureHtmlResponse('<html></html>');
      const csp = response.headers.get('Content-Security-Policy');
      expect(csp).toContain("'unsafe-inline'");
    });
  });

  describe('CSP Policies', () => {
    it('should use strictest policy for JSON', () => {
      const response = createSecureJsonResponse({ test: 'value' });
      const csp = response.headers.get('Content-Security-Policy');

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'none'");
      expect(csp).toContain("style-src 'none'");
    });

    it('should allow necessary features for HTML', () => {
      const response = createSecureHtmlResponse('<html></html>');
      const csp = response.headers.get('Content-Security-Policy');

      // Should allow scripts and styles (for OAuth)
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      
      // But still block frames
      expect(csp).toContain("frame-ancestors 'none'");
    });
  });
});
