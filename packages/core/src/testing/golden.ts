import type { AgentEvent } from '../protocol/events.ts';

/**
 * Golden-transcript normalizer (PHASE1-PLAN step 16). Without this, snapshots
 * flake on the first run: session ids and tool call ids are UUIDs, durations
 * are wall-clock, and workspace paths are per-test temp dirs.
 *
 * Everything that survives normalization is behavior we intend to pin.
 */
export interface StableOptions {
  /** Replaced with <WS> anywhere it appears, including inside strings. */
  workspaceRoot?: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Any remaining absolute path is host-specific — a temp dir on macOS
 * (/private/var/folders/…) differs from Linux CI (/tmp/…), and realpath adds
 * /private to /etc on macOS. Scrubbed AFTER the workspace substitution, so
 * in-workspace paths keep their meaning as <WS>/….
 */
const ABSOLUTE_PATH = /(?<=^|[\s("'`])\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+/g;

function scrubText(text: string, workspaceRoot?: string): string {
  let output = text;
  if (workspaceRoot !== undefined && workspaceRoot !== '') {
    output = output.split(workspaceRoot).join('<WS>');
  }
  return output
    .replace(UUID, '<id>')
    .replace(/\bmock-call-\d+\b/g, '<callId>')
    .replace(/\b\d+ms\b/g, '<ms>')
    .replace(/\bin \d+ms\b/g, 'in <ms>')
    .replace(ABSOLUTE_PATH, '<abs>');
}

function scrub(value: unknown, workspaceRoot?: string): unknown {
  if (typeof value === 'string') {
    return scrubText(value, workspaceRoot);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, workspaceRoot));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // Wall-clock values can never be stable.
      if (key === 'durationMs') {
        output[key] = '<ms>';
        continue;
      }
      output[key] = scrub(item, workspaceRoot);
    }
    return output;
  }
  return value;
}

export function stableEvents(
  events: readonly AgentEvent[],
  options: StableOptions = {}
): unknown[] {
  return events.map((event) => scrub(event, options.workspaceRoot));
}

/** Same normalization for text derived from events (e.g. summary lines). */
export function stableText(text: string, options: StableOptions = {}): string {
  return scrubText(text, options.workspaceRoot);
}

/** Compact one-line-per-event view; the readable half of a golden file. */
export function eventSummary(events: readonly AgentEvent[]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case 'assistant_text_delta':
      case 'assistant_thinking_delta':
        return `${event.type} ${JSON.stringify(event.text)}`;
      case 'tool_call_started':
        return `tool_call_started ${event.tool}`;
      case 'tool_call_completed':
        return `tool_call_completed ${event.ok ? 'ok' : 'error'} ${event.summary}`;
      case 'permission_requested':
        return `permission_requested ${event.request.tool}`;
      case 'permission_resolved':
        return `permission_resolved ${event.choice} by ${event.by}`;
      case 'turn_completed':
        return `turn_completed ${event.stopReason}`;
      case 'error':
        return `error ${event.severity} ${event.code}`;
      default:
        return event.type;
    }
  });
}
