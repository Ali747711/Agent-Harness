#!/usr/bin/env bash
# Dependency-direction rules from PHASE1-PLAN.md §3, enforced in CI.
#   1. packages/core must not import react/ink or anything from packages/cli.
#   2. Bun APIs (`Bun.` global, `bun:` modules) only inside core/src/runtime/.
#   3. @anthropic-ai/sdk only inside core/src/model/anthropic/.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# Rule 1: core is UI-free.
if grep -rnE "from ['\"](react|ink|@harness/cli)" packages/core/src --include='*.ts' --include='*.tsx' 2>/dev/null; then
  echo "BOUNDARY VIOLATION: packages/core imports UI or cli (rule 1)" >&2
  fail=1
fi

# Rule 2: Bun-specific APIs confined to core/src/runtime/ (ADR-0002).
if grep -rnE "(from ['\"]bun:|\bBun\.)" packages/core/src --include='*.ts' 2>/dev/null | grep -v 'packages/core/src/runtime/'; then
  echo "BOUNDARY VIOLATION: Bun API outside core/src/runtime/ (rule 2)" >&2
  fail=1
fi

# Rule 3: vendor SDK confined to the Anthropic adapter (ADR-0001/0010).
if grep -rnE "from ['\"]@anthropic-ai/sdk" packages --include='*.ts' 2>/dev/null | grep -v 'packages/core/src/model/anthropic/'; then
  echo "BOUNDARY VIOLATION: @anthropic-ai/sdk outside core/src/model/anthropic/ (rule 3)" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "boundaries ok"
