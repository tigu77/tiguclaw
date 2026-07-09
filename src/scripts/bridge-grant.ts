// src/scripts/bridge-grant.ts
/**
 * Dashboard V2 — 외부 access 용 토큰 발급 CLI.
 *
 *   npm run bridge:grant -- --label dashboard --role write --expires 30d
 *
 * raw token 은 stdout 에 1회만 표시되고 다시 볼 수 없다 (token_hash 만 DB 저장).
 */
import "../core/load-env.js"; // ★가장 먼저 — <home>/.env(레포 폴백) 로드.
import process from "node:process";
import { initStore } from "../store/sessions.js";
import {
  issueToken,
  type BridgeTokenRole,
} from "../store/bridge-tokens.js";

interface ParsedArgs {
  label: string | null;
  role: BridgeTokenRole | null;
  expires: string | null;
}

const parseArgs = (argv: string[]): ParsedArgs => {
  const out: ParsedArgs = { label: null, role: null, expires: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === "--label" && val !== undefined) {
      out.label = val;
      i++;
    } else if (key === "--role" && val !== undefined) {
      if (val === "read" || val === "write" || val === "admin") {
        out.role = val;
      } else {
        throw new Error(`invalid --role: ${val} (read|write|admin)`);
      }
      i++;
    } else if (key === "--expires" && val !== undefined) {
      out.expires = val;
      i++;
    }
  }
  return out;
};

// "30d" / "12h" / "45m" → ms. null = 영구.
export const parseExpires = (raw: string | null): number | undefined => {
  if (raw === null) return undefined;
  const m = /^(\d+)([dhm])$/.exec(raw);
  if (m === null) {
    throw new Error(`invalid --expires: ${raw} (예: 30d / 12h / 45m)`);
  }
  const n = Number(m[1]);
  const unit = m[2];
  const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
  return n * ms;
};

const usage = (): void => {
  console.log(
    "usage: npm run bridge:grant -- --label <name> --role <read|write|admin> [--expires <30d|12h|45m>]",
  );
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));
  if (args.label === null || args.role === null) {
    usage();
    process.exit(1);
  }

  const expiresInMs = parseExpires(args.expires);

  initStore();
  const result = issueToken(args.label, args.role, expiresInMs);

  const expiresStr =
    result.expiresAt === null
      ? "never"
      : new Date(result.expiresAt).toISOString();

  console.log("");
  console.log(`  token: ${result.token}`);
  console.log(
    `  id: ${result.id}, label: ${args.label}, role: ${args.role}, expires_at: ${expiresStr}`,
  );
  console.log("");
  console.log(
    "  IMPORTANT: this token will not be shown again. Store in .env or pass to client.",
  );
  console.log("");
};

main();
