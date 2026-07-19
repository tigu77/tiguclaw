#!/usr/bin/env bash
# Deterministic verifier for long-horizon-feature.
# Runs in the temp workspace (cwd). exit 0 = full test suite passes.
# Idempotent + side-effect free.
set -o pipefail
node --test
