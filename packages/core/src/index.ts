/**
 * @harness/core — headless agent runtime.
 *
 * Public surface grows per PHASE1-PLAN.md §4: protocol types, createSession(),
 * config. This package must never import React/Ink or write to stdout
 * (ADR-0003); Bun-specific APIs live only under src/runtime/ (ADR-0002).
 */
export const CORE_VERSION = '0.0.1';

export { AgentSession, type AgentSessionOptions } from './agent/session.ts';
export * from './config/index.ts';
export { HarnessError, type HarnessErrorCode, isHarnessError } from './errors/index.ts';
export * from './model/index.ts';
export { estimateCostUsd } from './model/pricing.ts';
export * from './permissions/index.ts';
export * from './protocol/index.ts';
export * from './session/index.ts';
export * from './tools/index.ts';
