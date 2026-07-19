#!/usr/bin/env bash
# Deterministic verifier for multi-file-refactor.
# Runs in the temp workspace (cwd). exit 0 = pass.
#   (a) every test passes AND
#   (b) the OLD symbol `computeTax` no longer appears in any source file.
# Idempotent + side-effect free.
set -o pipefail

node --test || exit 1

# (b) old symbol must be fully gone from non-test and test sources alike.
if grep -rn --include='*.js' 'computeTax' . ; then
  echo "FAIL: old symbol 'computeTax' still present" >&2
  exit 1
fi

exit 0
