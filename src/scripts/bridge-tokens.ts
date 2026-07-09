// src/scripts/bridge-tokens.ts
/**
 * Dashboard V2 — 활성 토큰 list / revoke CLI.
 *
 *   npm run bridge:tokens                      # list
 *   npm run bridge:tokens -- --revoke 3        # id=3 revoke
 */
import "../core/load-env.js"; // ★가장 먼저 — <home>/.env(레포 폴백) 로드.
import process from "node:process";
import { initStore } from "../store/sessions.js";
import { listActive, revokeToken } from "../store/bridge-tokens.js";

interface ParsedArgs {
  list: boolean;
  revoke: number | null;
}

const parseArgs = (argv: string[]): ParsedArgs => {
  const out: ParsedArgs = { list: true, revoke: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === "--list") {
      out.list = true;
    } else if (key === "--revoke" && val !== undefined) {
      const n = Number(val);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`invalid --revoke id: ${val}`);
      }
      out.revoke = n;
      out.list = false;
      i++;
    }
  }
  return out;
};

const fmtTime = (ts: number | null): string =>
  ts === null ? "never" : new Date(ts).toISOString();

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  initStore();

  if (args.revoke !== null) {
    const ok = revokeToken(args.revoke);
    if (ok) {
      console.log(`revoked id=${args.revoke}`);
      process.exit(0);
    } else {
      console.log(`no active token with id=${args.revoke}`);
      process.exit(1);
    }
    return;
  }

  const rows = listActive();
  if (rows.length === 0) {
    console.log("(no active tokens)");
    return;
  }

  console.log(
    `${"id".padEnd(4)} ${"role".padEnd(7)} ${"label".padEnd(24)} ${"created_at".padEnd(22)} expires_at`,
  );
  for (const r of rows) {
    console.log(
      `${String(r.id).padEnd(4)} ${r.role.padEnd(7)} ${r.label.padEnd(24)} ${fmtTime(r.createdAt).padEnd(22)} ${fmtTime(r.expiresAt)}`,
    );
  }
};

main();
