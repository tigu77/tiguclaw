/**
 * 회귀: 도구가 오래 걸린다는 통지가 **판정처럼 읽히지 않는다** (2026-08-14).
 *
 * 사고: 사용자가 "도구호출 한도는 자꾸 왜 걸리는거지" 라고 물었다. 실제로 걸린 한도는
 *  **하나도 없었다** — 전 기간 상한 이벤트 0건, 로그 창의 최대 iter 는 19(상한 150).
 *  사용자가 본 것은 이 경고였다:
 *
 *    "⏳ 백그라운드 작업 'X' 이(가) 도구 'Bash'에서 180초+ **멈춰 있어요**.
 *      OS 권한 요청 다이얼로그가 떠 있는지 … **확인해주세요**"
 *
 *  멈췄다고 **단정**하고, 드문 원인(권한 다이얼로그)을 **앞세우고**, 사용자에게 조치를
 *  **요구**한다. 정상적으로 오래 걸리는 빌드 하나가 사고 보고서로 읽혔다.
 *
 * ★진짜 뿌리는 문구가 아니라 **자리**다. 2026-08-12 에 같은 판단을 "오래 걸리는 건 실패가
 *  아니다" 로 고쳤는데 그때 고친 건 **로그뿐**이었고, 채널 푸시는 worker-jobs 에 따로
 *  적혀 있어 그대로 늙었다 — 하필 **사용자가 실제로 읽는 쪽**이. 같은 판단이 두 곳이면
 *  한쪽만 늙는다. 그래서 문구를 판정과 같은 자리(tool-watchdog)로 옮겼고, 이 검사는
 *  ①문구가 판정이 아닌 것 ②두 통지가 그 한 자리를 쓰는 것을 지킨다.
 */
import { readFile } from "node:fs/promises";
import { formatToolSlowNotice } from "../../core/llm-runtime/tool-watchdog.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const worker = formatToolSlowNotice({
    tool: "Bash",
    secs: 180,
    jobLabel: "VoxelBuilder G3 멀티모달 품질 마감",
  });
  const main = formatToolSlowNotice({ tool: "Bash", secs: 180 });

  // ── ① 단정하지 않는다 ────────────────────────────────────────────────────
  //  "멈춰 있어요" 가 사용자를 "한도에 걸렸다" 로 오독하게 만든 문장이다.
  const verdictWords = ["멈춰 있", "멈췄", "중단됐", "실패"];
  const hit = verdictWords.filter((w) => worker.includes(w) || main.includes(w));
  out.push(
    assert(
      "★멈췄다고 단정하지 않는다(경과 보고지 판정이 아니다)",
      hit.length === 0,
      hit.length === 0 ? "단정 표현 0" : `단정 표현: ${hit.join(",")}`,
    ),
  );

  // ── ② 정상이 먼저, 드문 원인이 나중 ──────────────────────────────────────
  //  순서가 곧 진단이다. 권한 다이얼로그를 앞세우면 그게 원인으로 읽힌다.
  const normalAt = worker.indexOf("정상");
  const rareAt = worker.indexOf("권한");
  out.push(
    assert(
      "★'정상일 수 있다' 가 드문 원인(권한 다이얼로그)보다 앞에 온다",
      normalAt > 0 && rareAt > 0 && normalAt < rareAt,
      `정상 idx=${normalAt} 권한 idx=${rareAt}`,
    ),
  );

  // ── ③ 되돌릴 수단을 준다 — 기다릴지 끊을지는 사용자가 정한다 ──────────────
  out.push(
    assert(
      "중단 수단을 준다(워커=cancel_worker · 메인=/stop)",
      worker.includes("cancel_worker") && main.includes("/stop") && !main.includes("cancel_worker"),
      `worker=${worker.includes("cancel_worker")} main=${main.includes("/stop")}`,
    ),
  );

  // ── ④ 경과 시간이 실린다(진단 수치 없는 통지는 소음이다) ──────────────────
  out.push(
    assert(
      "경과 초와 도구 이름이 실린다",
      worker.includes("180초") && worker.includes("Bash") && worker.includes("VoxelBuilder"),
      worker.slice(0, 60),
    ),
  );

  // ── ⑤ ★두 통지가 **같은 자리**를 쓴다 — 이번 사고의 뿌리 ──────────────────
  //  worker-jobs 가 문구를 다시 적으면 다음 재조정에서 또 한쪽만 늙는다.
  const src = await readFile(
    new URL("../../core/worker-jobs.ts", import.meta.url),
    "utf8",
  );
  const calls = (src.match(/formatToolSlowNotice\(/g) ?? []).length;
  out.push(
    assert(
      "★worker-jobs 의 도구-느림 통지 2곳이 공용 문구를 쓴다(자체 문구 금지)",
      calls === 2 && !src.includes("멈춰 있어요"),
      `formatToolSlowNotice 호출 ${calls}회 · 자체문구잔존=${src.includes("멈춰 있어요")}`,
    ),
  );

  // ── ⑥ ★호출부가 **초**를 넘긴다 (2026-08-14 적대 검토 ⑪) ───────────────────
  //  순수 함수는 잘 검사됐는데 **호출부가 옳게 부르는지**는 아무도 안 봤다. 변이 시험에서
  //  `ms: secs` 로 바꾸자 180초가 "0초째 실행 중" 으로 나갔고 992건 전부 초록이었다.
  //  단위 왕복 자체를 없앴으니(초를 받는다) 남은 건 "다시 ms 를 만들지 않는가" 다.
  {
    const src = await readFile(
      new URL("../../core/worker-jobs.ts", import.meta.url),
      "utf8",
    );
    const calls = [...src.matchAll(/formatToolSlowNotice\(\{([^}]*)\}\)/g)].map((m) => m[1] ?? "");
    out.push(
      assert(
        "★호출부 2곳이 secs 를 넘긴다(ms 왕복 금지)",
        calls.length === 2 && calls.every((a) => /\bsecs\b/.test(a) && !/\bms\b/.test(a) && !/\* 1000/.test(a)),
        `호출 ${calls.length}곳: ${calls.map((a) => a.replace(/\s+/g, " ").trim()).join(" | ")}`,
      ),
    );
    // ⑪ 곁가지 — 워커 통지는 jobLabel 을 넘겨야 `cancel_worker` 안내가 나간다.
    out.push(
      assert(
        "워커 호출부는 jobLabel 을 넘긴다(없으면 있지도 않은 /stop 을 안내한다)",
        calls.some((a) => /jobLabel/.test(a)),
        calls.join(" | "),
      ),
    );
  }

  // ── ⑦ ★구독이 실제로 걸린다 (적대 검토 ⑫ — 4점) ────────────────────────────
  //  종전 검사는 함수 **본문**만 봤다. `subscribeWorkerToolSlowNotify()` 호출 한 줄을
  //  지우면 워커·메인 턴 통지가 **전부** 사라지는데 992건이 초록이었다 —
  //  이 검사군이 태어난 사고(39분 무통지)가 그대로 재현되는데 그물이 없었다.
  {
    const src = await readFile(
      new URL("../../core/worker-jobs.ts", import.meta.url),
      "utf8",
    );
    const i = src.indexOf("export const registerWorkerHandler");
    const body = i < 0 ? "" : src.slice(i, i + 600);
    // ★주석 처리된 줄은 안 센다 — 첫 판은 문자열 포함만 봐서 `// subscribe…()` 로 주석
    //  처리하면 그대로 통과했다(재시험에서 걸렸다). "있다" 가 아니라 "**실행된다**" 를
    //  물어야 한다 — 이 검사가 태어난 이유가 정확히 그것이다.
    const live = body
      .split("\n")
      .some((l) => l.includes("subscribeWorkerToolSlowNotify()") && !l.trim().startsWith("//"));
    out.push(
      assert(
        "★registerWorkerHandler 가 도구-느림 구독을 건다(구독 없으면 통지 전멸)",
        live,
        i < 0 ? "registerWorkerHandler 없음" : live ? "구독 확인" : "★호출이 없거나 주석 처리됨",
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "tool-slow-is-not-a-verdict",
  guards:
    "정상적으로 오래 걸리는 도구를 '멈춰 있어요'로 단정해 사용자가 '한도에 걸렸다'고 읽던 것 — 2026-08-12 재조정이 로그만 고치고 채널 푸시를 빠뜨렸다(같은 판단이 두 곳)",
  run,
};
