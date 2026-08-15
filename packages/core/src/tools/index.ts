export { globTool } from './builtin/glob.ts';
export { readTool } from './builtin/read.ts';
export { ToolRegistry } from './registry.ts';
export {
  defineTool,
  errorResult,
  type RegisteredTool,
  type Tool,
  type ToolContext,
  type ToolPlanContext,
  type ToolResult
} from './tool.ts';

import { globTool } from './builtin/glob.ts';
import { readTool } from './builtin/read.ts';
import { ToolRegistry } from './registry.ts';

/** The Phase-1 built-in set (grows through steps 9–11). */
export function builtinToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(readTool).register(globTool);
}
