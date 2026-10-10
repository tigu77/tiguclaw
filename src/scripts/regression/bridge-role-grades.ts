/**
 * 회귀: **브리지 역할 등급이 기대표와 같고, 실제 요청에서 낮은 토큰이 403 을 받는다** (2026-10-09 전체 적대 검토 G3·P2).
 *
 * `bridge-role-table-complete` 는 «표에 **빠졌는가**» 만 본다 — 등급이 **적절한가**는 사람 몫이라고 적어 뒀고, 그래서
 * admin 경로를 write 로 내리는 변이는 아무 검사에도 안 걸렸다. 그리고 실제로 한 쌍이 어긋나 있었다:
 * `/set-module-enabled`(write) 와 `/plugins/action enable|disable`(admin) 이 **같은 `setModuleDisabled`** 에 닿는다 —
 * write 토큰이 admin 문을 옆문으로 넘었다(P2, 이 커밋에서 admin 으로 맞춤).
 *
 * 그래서 **기대 등급표**를 여기 둔다(등급을 바꾸려면 이 표도 같이 바꿔야 한다 = 의도적 결정만 통과).
 *  ① 소스 role 표의 등급이 기대표와 같다(`/self-update` 처럼 실제로 두드릴 수 없는 것까지)
 *  ② ★진짜 브리지를 띄워 **기대 등급보다 낮은 토큰**으로 두드리면 403 + `required` 가 기대 등급이다
 *     (admin 경로 ← read·write, write 경로 ← read, 커스텀 엔드포인트의 선언 role 포함)
 *  ③ 대조군 — 두 토큰이 유효하다(403 이 «토큰 무효» 가 아니다)
 *
 * 등급: **동작**(자식 프로세스 + 실제 HTTP, 핸들러에는 닿지 않는다).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync } from "./_wiring.js";

const CHILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "_bridge-roles-child.ts");

type Grade = "write" | "admin";
/** 기대 등급표 — admin 은 전부, write 는 상태를 바꾸는 것 전부. 키는 `METHOD path`. */
const EXPECTED: Record<string, Grade> = {
  "POST /plugins/action": "admin",
  "POST /set-module-enabled": "admin",
  "POST /restart": "admin",
  "POST /self-update": "admin",
  "POST /log-clear": "admin",
  "POST /cancel-queued": "admin",
  "POST /auth-login-begin": "admin",
  "POST /auth-login-finish": "admin",
  "POST /messages": "write",
  "POST /session-name": "write",
  "POST /session-archive": "write",
  "POST /set-default-profile": "write",
  "POST /session-projects": "write",
  "POST /set-session-profile": "write",
  "POST /set-egress": "write",
  "POST /set-suggestion": "write",
  "POST /set-memory-cap": "write",
  "POST /set-locale": "write",
  "POST /set-theme": "write",
  "POST /set-profile-color": "write",
  "GET /auth-usage": "write",
  "POST /transcribe": "write",
  "POST /cancel-worker": "write",
  "POST /kill-shell": "write",
  "POST /open-path": "write",
  "POST /project-forget": "write",
  "POST /project-rename": "write",
  "POST /home-widgets": "write",
};
/** 커스텀 엔드포인트(자식이 홈에 만든다) — 선언 role 이 게이트다 · 미선언은 write 기본. */
const CUSTOM: Record<string, Grade> = { "POST /regr-admin-ep": "admin", "POST /regr-default-ep": "write" };
/** 게이트가 깨진 날 요청 자체가 사고인 것 — 표(①)로만 본다. */
const NOT_LIVE = new Set(["POST /self-update"]);

/** 소스 role 표에서 `METHOD path → 등급` 을 뽑는다(사이 주석 줄 허용). */
const sourceGrades = (src: string): Map<string, string> => {
  const out = new Map<string, string>();
  const start = src.indexOf("const required: BridgeTokenRole | null =");
  const table = start < 0 ? "" : src.slice(start, src.indexOf("\n    if (", start));
  const re = /pathname === "([^"]+)" && method === "([A-Z]+)"\s*(?:\/\/[^\n]*\s*)*\?\s*"(read|write|admin)"/g;
  for (const m of table.matchAll(re)) out.set(`${m[2]} ${m[1]}`, m[3]!);
  return out;
};

interface Hit {
  status: number;
  required?: string;
}
interface Probe {
  rows?: Array<{ path: string; method: string; grade: Grade; read: Hit; write?: Hit }>;
  control?: { read: Hit; write: Hit };
}

export const check: RegressionCheck = {
  name: "bridge-role-grades",
  guards:
    "브리지 admin·write 등급을 낮춰도 잡는 검사가 없던 것(표 누락만 봤다) + `/set-module-enabled`(write) 가 `/plugins/action`(admin) 과 같은 일을 해 write 토큰이 admin 문을 옆문으로 넘던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 소스 표 == 기대표 ───────────────────────────────────────────
    const grades = sourceGrades(readSourceSync("plugins/http-bridge/index.ts"));
    const mismatched = Object.entries(EXPECTED)
      .filter(([k, g]) => grades.get(k) !== g)
      .map(([k, g]) => `${k}: 기대 ${g} / 소스 ${grades.get(k) ?? "없음"}`);
    out.push(
      assert(
        "★소스 role 표의 admin·write 등급이 기대표와 같다",
        grades.size > 30 && mismatched.length === 0,
        mismatched.length === 0 ? `표에서 읽은 ${grades.size}개 · 기대 ${Object.keys(EXPECTED).length}개 일치` : mismatched.join(" · "),
      ),
    );

    // ── ②③ 진짜 요청 ─────────────────────────────────────────────────
    const probes = [...Object.entries(EXPECTED), ...Object.entries(CUSTOM)]
      .filter(([k]) => !NOT_LIVE.has(k))
      .map(([k, grade]) => {
        const [method, p] = k.split(" ");
        return { method: method!, path: p!, grade };
      });
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD, JSON.stringify(probes)], {
      encoding: "utf8",
      timeout: 60_000,
      env: process.env,
    });
    let got: Probe = {};
    try {
      got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Probe;
    } catch {
      got = {};
    }
    const rows = got.rows ?? [];
    const leaks: string[] = [];
    for (const row of rows) {
      const tokens: Array<[string, Hit | undefined]> = [["read", row.read], ...(row.grade === "admin" ? [["write", row.write] as [string, Hit | undefined]] : [])];
      for (const [tok, hit] of tokens) {
        if (hit?.status !== 403 || hit.required !== row.grade) leaks.push(`${row.method} ${row.path} ← ${tok}: ${hit?.status ?? "?"} required=${hit?.required ?? "-"}`);
      }
    }
    out.push(
      assert(
        "★기대 등급보다 낮은 토큰은 403 이고 required 가 기대 등급이다(admin ← read·write, write ← read, 커스텀 엔드포인트 포함)",
        rows.length === probes.length && leaks.length === 0,
        leaks.length === 0 && rows.length === probes.length
          ? `요청 ${rows.length}경로 전부 403`
          : `경로 ${rows.length}/${probes.length} · 샌 곳 ${leaks.join(" · ") || "없음"} · stderr ${(r.stderr ?? "").slice(-200)}`,
      ),
    );
    out.push(
      assert(
        "대조군 — read·write 토큰이 유효하다(403 이 «토큰 무효» 가 아니라 «등급 부족» 이다)",
        got.control?.read.status === 200 && got.control.write.status === 200,
        `GET /channels read=${got.control?.read.status ?? "?"} write=${got.control?.write.status ?? "?"}`,
      ),
    );
    return out;
  },
};
