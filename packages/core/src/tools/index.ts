export { bashTool } from './builtin/bash.ts';
export { editTool } from './builtin/edit.ts';
export { globTool } from './builtin/glob.ts';
export { grepTool } from './builtin/grep.ts';
export { readTool } from './builtin/read.ts';
export { writeTool } from './builtin/write.ts';
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
export { FileTracker, type TrackedFile } from './tracker.ts';

import { bashTool } from './builtin/bash.ts';
import { editTool } from './builtin/edit.ts';
import { globTool } from './builtin/glob.ts';
import { grepTool } from './builtin/grep.ts';
import { readTool } from './builtin/read.ts';
import { writeTool } from './builtin/write.ts';
import { ToolRegistry } from './registry.ts';

/** The complete Phase-1 built-in set (ADR-0007). */
export function builtinToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(globTool)
    .register(grepTool)
    .register(writeTool)
    .register(editTool)
    .register(bashTool);
}
