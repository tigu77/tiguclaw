#!/usr/bin/env bash
# Deterministic verifier for iterative-multi-bug.
# Runs in the temp workspace (cwd). exit 0 = all tests pass.
# Idempotent + side-effect free — safe to re-run for convergence probing.
set -o pipefail
node --test
