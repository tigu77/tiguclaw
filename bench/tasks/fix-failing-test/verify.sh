#!/usr/bin/env bash
# Deterministic verifier for the fix-failing-test task.
# Runs in the temp workspace (cwd). exit 0 = pass, non-zero = fail.
# Idempotent + side-effect free: node --test only reads/executes the sources,
# so the harness may re-run it any number of times to probe convergence.
set -o pipefail
node --test
