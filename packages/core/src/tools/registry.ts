import { z } from 'zod';

import { HarnessError } from '../errors/index.ts';
import type { ToolSpec } from '../model/types.ts';
import type { RegisteredTool } from './tool.ts';

/**
 * ToolRegistry (ADR-0007/0008): deterministic ordering (sorted by name) and
 * byte-stable wire specs — the tool list is part of the cached prompt prefix,
 * so two constructions of the same registry MUST serialize identically.
 */

/**
 * The API's tool-schema validator rejects numeric-range keywords on
 * integer/number types (live 400: "For 'integer' type, properties
 * exclusiveMinimum, maximum are not supported"). Strip them from the wire —
 * the loop re-validates inputs with the full Zod schema before execution,
 * so the bounds still hold at runtime.
 */
const UNSUPPORTED_NUMERIC_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf'
] as const;

function sanitizeForWire(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeForWire);
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const output: Record<string, unknown> = {};
  const source = node as Record<string, unknown>;
  const isNumeric = source.type === 'integer' || source.type === 'number';
  for (const [key, value] of Object.entries(source)) {
    if (isNumeric && (UNSUPPORTED_NUMERIC_KEYWORDS as readonly string[]).includes(key)) {
      continue;
    }
    output[key] = sanitizeForWire(value);
  }
  return output;
}
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): this {
    if (this.tools.has(tool.name)) {
      throw new HarnessError('internal', `duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  toWireSpecs(): ToolSpec[] {
    return this.list().map((tool) => {
      const raw = z.toJSONSchema(tool.schema) as Record<string, unknown>;
      // The $schema marker is meta-noise on the wire and a cache-stability
      // hazard if the emitting library changes its default dialect.
      delete raw.$schema;
      const schema = sanitizeForWire(raw) as Record<string, unknown>;
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: schema,
        strict: true
      };
    });
  }
}
