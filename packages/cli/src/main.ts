#!/usr/bin/env bun
/**
 * @harness/cli entrypoint. Routes to headless mode (-p) or the interactive
 * TUI (PHASE1-PLAN.md step 4 / step 13). Placeholder until step 4.
 */
import { CORE_VERSION } from '@harness/core';

// Placeholder wiring proof: cli → core dependency direction (ADR-0003).
process.stderr.write(`harness ${CORE_VERSION} — scaffold placeholder; loop lands in step 4\n`);
