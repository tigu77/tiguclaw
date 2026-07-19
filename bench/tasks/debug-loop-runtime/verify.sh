#!/usr/bin/env bash
# Deterministic verifier for debug-loop-runtime (§A태스크2, hidden oracle).
# Runs in the temp workspace (cwd). exit 0 = pass.
#
# hidden oracle pattern: the authoritative test (oracle.test.js) lives in the
# task dir (NOT the agent's workspace). We copy it in, run the FULL suite (dev
# tests + oracle), then remove it. Effect: (a) golden answers never exposed as a
# static file -> agent must run its code to converge; (b) fresh copy each time
# -> idempotent, side-effect free.
set -o pipefail

oracle_src="${BENCH_TASK_DIR}/oracle.test.js"
oracle_dst="./oracle.test.js"

cleanup() { rm -f "$oracle_dst"; }
trap cleanup EXIT

if [ ! -f "$oracle_src" ]; then
  echo "verify: oracle missing at $oracle_src (BENCH_TASK_DIR unset?)" >&2
  exit 2
fi
cp "$oracle_src" "$oracle_dst"

node --test
