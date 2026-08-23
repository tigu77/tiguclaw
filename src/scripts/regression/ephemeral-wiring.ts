/**
 * 회귀: **휘발성 명령의 배선** — 발행은 하고 적재만 건너뛴다 (2026-08-23 3라운드 ③-1).
 *
 * `room-notice-is-ephemeral` 은 버스에 직접 이벤트를 흘려 `event-persist` 만 본다.
 * 정작 **판단이 사는 곳**(`src/index.ts` 의 `publishInboundEcho(msg,{ephemeral})` ·
 * `replyCommand(..,{ephemeral})` · `/sessions` 블록의 `const ephemeral`)은 클로저 안이라
 * 스위트가 **한 번도 실행하지 않았다**. 그래서 1라운드 결함을 그대로 복원해도 1,608건이
 * 초록이었고(레드팀 변이 C4·A2·D4 전부 통과), 4점짜리 자리에 그물이 0이었다.
 *
 * ★**두 축을 같이 본다.** 이 기능은 하루에 양방향으로 틀렸다:
 *   ①적재를 막으려고 **발행을 껐더니** 대시보드 낙관 버블이 "대기 중" 으로 영구히 굳었다
 *     (그 이벤트는 기록만 하는 게 아니라 버블 승격·진행 표시·에러 클리어까지 켠다)
 *   ②`{ephemeral}` 이 일부 분기에만 있어 **명령만 사라지고 답이 남았다**
 *   한 축만 보는 검사는 반대편을 놓친다 — SSE(라이브 표시)와 `chat_log`(적재)를 둘 다 읽는다.
 *
 * ★비싸다(데몬 부팅 1회 ~20초). 그만한 이유: 이 배선은 import 로 못 뽑고, 슬래시 명령은
 *  LLM 을 안 타므로 부팅 한 번이면 **모델·네트워크와 무관하게** 실측이 된다. 격리 홈·격리
 *  포트·텔레그램 토큰 없음이라 라이브 데몬과 겹치지 않는다.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "_ephemeral-wiring-child.ts",
);

interface Probe {
  booted?: boolean;
  why?: string;
  sseErr?: string;
  rows?: string[];
  sse?: Array<{ type: string; text: string; ephemeral: boolean }>;
  tail?: string;
}

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "eph-wiring-"));
  let got: Probe = {};
  let tail = "";
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
      encoding: "utf8",
      // ★90초 — 프로브 실측 5초. 종전 180초 × 2건 = 360초로 CI 예산(5분)을 넘겨,
      //  둘이 동시에 걸리면 스텝이 통째로 잘려 **1,559건 신호가 전부 사라진다**.
      timeout: 90_000,
      // ★포트를 안 넘긴다 — 자식이 커널에서 빈 포트를 받는다(병렬 워크트리 충돌 방지).
      env: { ...process.env, PROBE_HOME: home },
    });
    tail = (r.stderr ?? "").trim().slice(-200);
    try {
      got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Probe;
    } catch {
      got = {};
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const rows = got.rows ?? [];
  const sse = got.sse ?? [];
  const joined = rows.join(" | ");
  out.push(
    assert(
      "프로브 데몬이 떴다(안 뜨면 아래 판정은 무의미)",
      got.booted === true,
      got.why ?? (got.booted === true ? "부팅 확인" : `★부팅 실패 · ${tail || (got.tail ?? "")}`),
    ),
  );
  if (got.booted !== true) return out;

  // ── ① 적재 축 — 휘발성 명령은 명령도 답도 안 남는다 ────────────────────────────
  {
    // 앵커는 **행 머리**로 잡는다 — 본문 부분일치로 잡으면 다른 턴이 그 이름을 언급만
    // 해도 오탐한다(실제로 그렇게 한 번 틀렸다).
    const leaked = rows.filter(
      (r) => r.startsWith("user:/sessions new") || r.startsWith("assistant:새 세션"),
    );
    out.push(
      assert(
        "★휘발성 명령은 chat_log 에 안 남는다(명령·응답 둘 다)",
        leaked.length === 0,
        leaked.length === 0 ? "적재 0건" : `★${leaked.length}건 남음: ${leaked.join(" / ")}`,
      ),
    );
  }

  // ── ② 표시 축 — 그런데 **발행은 된다**(버블이 "대기 중" 으로 굳지 않게) ─────────
  {
    const inEv = sse.find((e) => e.type === "channel.message.in" && e.text.includes("휘발성회귀"));
    const outEv = sse.find((e) => e.type === "channel.message.out" && e.text.includes("휘발성회귀"));
    out.push(
      assert(
        "★휘발성이어도 인바운드는 **발행된다**(낙관 버블 승격·진행 표시가 살아있어야 한다)",
        inEv !== undefined && inEv.ephemeral === true,
        inEv === undefined
          ? (got.sseErr ?? "") !== ""
            ? `★환경: SSE 구독 자체가 실패했다(제품 결함 아님) — ${got.sseErr}`
            : "★인바운드 이벤트 0 — 명령 버블이 '대기 중' 으로 영구히 굳는다(2026-07-16 /stop 기제)"
          : `발행됨 · ephemeral=${String(inEv.ephemeral)}`,
      ),
      assert(
        "★휘발성 응답도 **발행된다**(그 채널에 한 번 보이고 안 남는 것이 휘발이다)",
        outEv !== undefined && outEv.ephemeral === true,
        outEv === undefined
          ? "★아웃바운드 이벤트 0 — 응답이 화면에 아예 안 뜬다"
          : `발행됨 · ephemeral=${String(outEv.ephemeral)}`,
      ),
    );
  }

  // ── ③ 선택지 호출은 **짝을 맞춰** 안 남는다 (2026-08-23 4라운드) ────────────────
  //  `/sessions`(목록)는 선택지 UI 로 답하는데, `presentOptions` 는 cli=stdout /
  //  telegram=`ctx.reply` 라 **버스를 안 탄다** → 종전엔 명령만 남아 **답 없는 명령 버블**
  //  이었다(우리가 4점으로 고쳤다던 그 모양 그대로). 조회는 휘발, 변경은 기록으로 갈랐다.
  {
    const orphan = rows.filter((r) => r === "user:/sessions" || r.startsWith("user:/sessions arch"));
    const onlyChange = orphan.every((r) => r.includes("dashboard:")); // 인자 있는 것만 허용
    out.push(
      assert(
        "★선택지로 답하는 `/sessions` 호출은 고아 명령을 안 남긴다",
        onlyChange,
        onlyChange
          ? "조회 휘발 확인(짝이 안 맞는 명령 0)"
          : `★답 없는 명령이 남았다: ${orphan.filter((r) => !r.includes("dashboard:")).join(" / ")}`,
      ),
    );
  }

  // ── ④ 휘발이 **아닌** `/sessions` 응답은 남는다 (4라운드 — 4점 그물 구멍) ──────
  //  이 단언이 없던 동안 `const ephemeral` 을 `true` 로 바꿔 보관·복원 확인, "그런 세션이
  //  없습니다", 셀렉터 거절이 **전부 기록에서 증발**해도 스위트가 초록이었다.
  {
    const cmd = rows.some((r) => r.startsWith("user:/sessions archive dashboard:no-such"));
    const ans = rows.some((r) => r.startsWith("assistant:") && r.includes("no-such-session-xyz"));
    out.push(
      assert(
        "★상태 변경 명령(`/sessions archive <id>`)은 명령·응답이 **둘 다** 남는다",
        cmd && ans,
        cmd && ans
          ? "쌍으로 적재 확인"
          : `★${!cmd ? "명령" : "응답"}이 없다 — 휘발이 기록해야 할 것까지 먹었다: ${joined}`,
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "ephemeral-wiring",
  guards:
    "휘발성 명령 배선(index.ts 클로저)에 그물이 0이라 1라운드 결함을 복원해도 스위트가 초록이던 것 — 적재를 막으려 발행을 꺼서 명령 버블이 '대기 중' 으로 굳던 것 + 판정이 핸들러와 갈려 명령·답 중 한쪽만 사라지던 것(양방향)",
  run,
};
export default check;
