import { z } from 'zod';

import { HarnessError } from '../errors/index.ts';
import type { ToolSpec } from '../model/types.ts';
import type { RegisteredTool } from './tool.ts';

/**
 * ToolRegistry (ADR-0007/0008): deterministic ordering (sorted by name) and
 * byte-stable wire specs — the tool list is part of the cached prompt prefix,
 * so two constructions of the same registry MUST serialize identically.
 */
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
      const schema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
      // The $schema marker is meta-noise on the wire and a cache-stability
      // hazard if the emitting library changes its default dialect.
      delete schema.$schema;
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: schema,
        strict: true
      };
    });
  }
}
