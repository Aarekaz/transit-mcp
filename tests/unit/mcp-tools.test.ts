/**
 * MCP 2025-06-18 surface tests.
 *
 * Locks down the contract for every tool in MCP_TOOLS:
 *  - Has the required 2025-06-18 fields (title, annotations, outputSchema)
 *  - annotations declare every tool as read-only / idempotent / open-world
 *  - outputSchema is a valid top-level object schema with declared `required`
 *
 * These are pure shape assertions — no transit API calls — so they run fast
 * and stay green even if upstream WMATA/MTA is unreachable.
 */

import { describe, it, expect } from 'vitest';
import { MCP_TOOLS } from '../../src/mcp-tools';

describe('MCP_TOOLS — 2025-06-18 surface', () => {
  it('exports at least the 13 documented tools', () => {
    expect(MCP_TOOLS.length).toBeGreaterThanOrEqual(13);
  });

  it.each(MCP_TOOLS.map(t => [t.name, t] as const))(
    '%s — declares the 2025-06-18 fields',
    (_name, tool) => {
      expect(tool.title, 'title (human-readable)').toBeTypeOf('string');
      expect(tool.title!.length, 'title is non-empty').toBeGreaterThan(0);

      expect(tool.annotations, 'annotations').toBeDefined();
      expect(tool.annotations!.readOnlyHint, 'readOnlyHint').toBe(true);
      expect(tool.annotations!.idempotentHint, 'idempotentHint').toBe(true);
      expect(tool.annotations!.openWorldHint, 'openWorldHint').toBe(true);

      expect(tool.outputSchema, 'outputSchema').toBeDefined();
      expect(tool.outputSchema!.type, 'outputSchema.type').toBe('object');
      expect(tool.outputSchema!.properties, 'outputSchema.properties').toBeTypeOf('object');
      expect(Array.isArray(tool.outputSchema!.required), 'outputSchema.required').toBe(true);
      expect(tool.outputSchema!.required!.length, 'outputSchema has ≥1 required field')
        .toBeGreaterThan(0);
    }
  );

  it('every outputSchema "required" field actually exists in "properties"', () => {
    for (const tool of MCP_TOOLS) {
      const schema = tool.outputSchema!;
      for (const field of schema.required!) {
        expect(
          schema.properties[field],
          `${tool.name}.outputSchema declares "${field}" as required but it is missing from properties`
        ).toBeDefined();
      }
    }
  });

  it('every tool name is unique', () => {
    const names = MCP_TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
