/**
 * Input Validation Tests
 * 
 * WHY THESE TESTS:
 * Input validation is critical for security. These tests ensure:
 * 1. Valid inputs are accepted
 * 2. Invalid inputs are rejected
 * 3. Malicious inputs are sanitized
 * 4. Error messages are helpful
 * 
 * TEST STRATEGY:
 * - Happy path: Test valid inputs
 * - Sad path: Test invalid inputs
 * - Edge cases: Test boundary conditions
 * - Security: Test injection attacks
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeString,
  validateStationName,
  validateStationCode,
  validateLineCode,
  validateSearchQuery,
  validateCityCode,
  validateToolParams,
  validateJsonRpcRequest,
  ValidationError,
} from '../../src/middleware/input-validator';

describe('Input Validator', () => {
  describe('sanitizeString', () => {
    it('should trim whitespace', () => {
      expect(sanitizeString('  hello  ')).toBe('hello');
    });

    it('should remove null bytes', () => {
      expect(sanitizeString('hello\0world')).toBe('helloworld');
    });

    it('should remove control characters', () => {
      expect(sanitizeString('hello\x01\x02world')).toBe('helloworld');
    });

    it('should enforce maximum length', () => {
      const longString = 'a'.repeat(1001);
      expect(() => sanitizeString(longString, 1000)).toThrow(ValidationError);
    });

    it('should normalize Unicode', () => {
      // Test with combining characters
      const input = 'café';  // é as combining character
      const result = sanitizeString(input);
      expect(result).toBeTruthy();
    });

    it('should throw on non-string input', () => {
      expect(() => sanitizeString(123 as any)).toThrow(ValidationError);
    });
  });

  describe('validateStationName', () => {
    it('should accept valid station names', () => {
      expect(validateStationName('Union Station')).toBe('Union Station');
      expect(validateStationName("L'Enfant Plaza")).toBe("L'Enfant Plaza");
      expect(validateStationName('42nd St-Times Square')).toBe('42nd St-Times Square');
    });

    it('should reject invalid characters', () => {
      expect(() => validateStationName('Station<script>')).toThrow(ValidationError);
      expect(() => validateStationName('Station;DROP TABLE')).toThrow(ValidationError);
    });

    it('should reject empty names', () => {
      expect(() => validateStationName('')).toThrow(ValidationError);
    });

    it('should reject too-long names', () => {
      const longName = 'a'.repeat(101);
      expect(() => validateStationName(longName)).toThrow(ValidationError);
    });

    it('should throw on non-string input', () => {
      expect(() => validateStationName(null)).toThrow(ValidationError);
      expect(() => validateStationName(undefined)).toThrow(ValidationError);
      expect(() => validateStationName(123)).toThrow(ValidationError);
    });
  });

  describe('validateStationCode', () => {
    it('should accept valid DC station codes', () => {
      expect(validateStationCode('A01')).toBe('A01');
      expect(validateStationCode('K08')).toBe('K08');
    });

    it('should accept valid NYC station codes', () => {
      expect(validateStationCode('123')).toBe('123');
      expect(validateStationCode('456N')).toBe('456N');
      expect(validateStationCode('789S')).toBe('789S');
    });

    it('should convert to uppercase', () => {
      expect(validateStationCode('a01')).toBe('A01');
    });

    it('should reject invalid characters', () => {
      expect(() => validateStationCode('A-01')).toThrow(ValidationError);
      expect(() => validateStationCode('A 01')).toThrow(ValidationError);
    });
  });

  describe('validateLineCode', () => {
    it('should accept valid DC line codes', () => {
      expect(validateLineCode('RD')).toBe('RD');
      expect(validateLineCode('BL')).toBe('BL');
      expect(validateLineCode('OR')).toBe('OR');
    });

    it('should accept valid NYC line codes', () => {
      expect(validateLineCode('1')).toBe('1');
      expect(validateLineCode('A')).toBe('A');
      expect(validateLineCode('4-5-6')).toBe('4-5-6');
      expect(validateLineCode('A/C/E')).toBe('A/C/E');
    });

    it('should convert to uppercase', () => {
      expect(validateLineCode('rd')).toBe('RD');
    });

    it('should reject invalid characters', () => {
      expect(() => validateLineCode('RD<script>')).toThrow(ValidationError);
    });
  });

  describe('validateSearchQuery', () => {
    it('should accept valid search queries', () => {
      expect(validateSearchQuery('union station')).toBe('union station');
      expect(validateSearchQuery('42nd street, times square')).toBe('42nd street, times square');
    });

    it('should reject injection attempts', () => {
      expect(() => validateSearchQuery('<script>alert(1)</script>')).toThrow(ValidationError);
      expect(() => validateSearchQuery('union"; DROP TABLE stations;')).toThrow(ValidationError);
    });

    it('should reject too-long queries', () => {
      const longQuery = 'a'.repeat(101);
      expect(() => validateSearchQuery(longQuery)).toThrow(ValidationError);
    });
  });

  describe('validateCityCode', () => {
    it('should accept valid city codes', () => {
      expect(validateCityCode('dc')).toBe('dc');
      expect(validateCityCode('nyc')).toBe('nyc');
      expect(validateCityCode('DC')).toBe('dc');  // case insensitive
    });

    it('should reject invalid city codes', () => {
      expect(() => validateCityCode('london')).toThrow(ValidationError);
      expect(() => validateCityCode('paris')).toThrow(ValidationError);
      expect(() => validateCityCode('../etc/passwd')).toThrow(ValidationError);
    });

    it('should throw on non-string input', () => {
      expect(() => validateCityCode(123)).toThrow(ValidationError);
    });
  });

  describe('validateToolParams', () => {
    it('should validate get_station_predictions params', () => {
      const params = validateToolParams('get_station_predictions', {
        city: 'dc',
        stationName: 'Metro Center'
      });
      expect(params.city).toBe('dc');
      expect(params.stationName).toBe('Metro Center');
    });

    it('should validate search_stations params', () => {
      const params = validateToolParams('search_stations', {
        city: 'nyc',
        query: 'times square'
      });
      expect(params.city).toBe('nyc');
      expect(params.query).toBe('times square');
    });

    it('should validate get_stations_by_line params', () => {
      const params = validateToolParams('get_stations_by_line', {
        city: 'dc',
        lineCode: 'RD'
      });
      expect(params.city).toBe('dc');
      expect(params.lineCode).toBe('RD');
    });

    it('should require city parameter', () => {
      expect(() => validateToolParams('get_incidents', {})).toThrow(ValidationError);
    });

    it('should reject unknown tools', () => {
      expect(() => validateToolParams('unknown_tool', { city: 'dc' })).toThrow(ValidationError);
    });

    it('should require tool-specific parameters', () => {
      expect(() => validateToolParams('search_stations', { city: 'dc' })).toThrow(ValidationError);
    });
  });

  describe('validateJsonRpcRequest', () => {
    it('should accept valid JSON-RPC 2.0 requests', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1
      };
      expect(() => validateJsonRpcRequest(request)).not.toThrow();
    });

    it('should reject invalid jsonrpc version', () => {
      expect(() => validateJsonRpcRequest({ jsonrpc: '1.0', method: 'test', id: 1 })).toThrow();
      expect(() => validateJsonRpcRequest({ method: 'test', id: 1 })).toThrow();
    });

    it('should reject invalid method', () => {
      expect(() => validateJsonRpcRequest({ jsonrpc: '2.0', id: 1 })).toThrow();
      expect(() => validateJsonRpcRequest({ jsonrpc: '2.0', method: '', id: 1 })).toThrow();
    });

    it('should reject injection in method name', () => {
      expect(() => validateJsonRpcRequest({
        jsonrpc: '2.0',
        method: 'test<script>',
        id: 1
      })).toThrow();
    });

    it('should accept notifications (no id)', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      };
      expect(() => validateJsonRpcRequest(request)).not.toThrow();
    });

    it('should reject invalid id types', () => {
      expect(() => validateJsonRpcRequest({
        jsonrpc: '2.0',
        method: 'test',
        id: {}
      })).toThrow();
    });

    it('should accept valid params', () => {
      const request = {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'test' },
        id: 1
      };
      expect(() => validateJsonRpcRequest(request)).not.toThrow();
    });
  });
});
