#!/usr/bin/env bash
# Deterministic verifier for constraint-compliance (§A태스크3).
# Runs in the temp workspace (cwd). exit 0 = ALL checks pass.
# Also emits a structured `BENCH_VERIFY_JSON=` line (last line) so the harness can
# record per-constraint compliance (dilution hypothesis). exit-code stays the truth.
# Idempotent + side-effect free.
set -o pipefail

seed="${BENCH_TASK_DIR}/workspace/frozen.js"

# check 1 — functional tests pass.
if node --test >/dev/null 2>&1; then func=true; else func=false; fi

# check 2 — frozen.js unmodified (hash equals the pristine seed).
if [ -f "$seed" ] \
  && [ "$(shasum -a 256 frozen.js | awk '{print $1}')" = "$(shasum -a 256 "$seed" | awk '{print $1}')" ]; then
  frozen=true
else
  frozen=false
fi

# check 3 — no async in the solution (render.js): no async/await/.then/Promise.
if grep -nE 'async|await|\.then|Promise' render.js >/dev/null 2>&1; then
  noasync=false
else
  noasync=true
fi

# check 4 — no module-level mutable state in render.js (no top-level let/var).
if grep -nE '^(let|var)[[:space:]]' render.js >/dev/null 2>&1; then
  nostate=false
else
  nostate=true
fi

echo "BENCH_VERIFY_JSON={\"checks\":[{\"name\":\"functional-tests\",\"passed\":$func},{\"name\":\"no-modify-frozen\",\"passed\":$frozen},{\"name\":\"no-async\",\"passed\":$noasync},{\"name\":\"no-module-state\",\"passed\":$nostate}]}"

if [ "$func" = true ] && [ "$frozen" = true ] && [ "$noasync" = true ] && [ "$nostate" = true ]; then
  exit 0
fi
exit 1
