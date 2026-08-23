/**
 * 회귀: **같은 ts 가 여럿이어도 이력을 전수 수집한다** (2026-08-23 3라운드).
 *
 * 라이브 DB 는 같은 밀리초에 여러 행이 흔하다(질문·답 쌍, 도구 스텝 묶음). `ts <` 만으로
 * 페이징하면 **경계에 걸린 동률 행이 영영 안 온다** — 조용하고, 새로고침해도 같고,
 * 사용자는 "예전 대화가 사라졌다" 로만 겪는다.
 *
 * ★이 검사가 왜 늦게 생겼나: 복합 커서는 1라운드에서 4점으로 닫았는데, 그 뒤 회귀
 *  1,613건 중 **`beforeId` 라는 문자열을 언급하는 검사가 0건**이었다. 그래서 2라운드가
 *  브리지의 파싱을 **살아 있는 핸들러 쪽에서** 잘못 지워도(일괄 치환이 두 핸들러를 다
 *  잡았고 주석·커밋 메시지·백로그가 셋 다 반대로 적혔다) 아무도 못 봤다. 실측 귀결:
 *  120행 중 96행 수집 — **24행(20%) 영구 유실**. 4점짜리 수정에 그물이 0이면 그 수정은
 *  다음 커밋에 사라진다. [[feedback_gate_must_actually_run]]
 *
 * ★**두 층을 다 돈다.** 복합 커서는 `chat-log.ts`(SQL) · `http-bridge`(쿼리 파싱) ·
 *  `history-render.js`(커서 전달) 셋이 다 맞아야 산다. 한 층만 보면 나머지가 조용히 죽는다.
 *  ①스토어: `getRecentChatLog` 로 끝까지 페이징 ②HTTP: **실제 데몬**을 띄워 브리지
 *  `/chat-history` 로 같은 순회. 그리고 ③`ts <` 만으로는 **못 모은다**는 것까지 확인한다
 *  (반대편이 없으면 항상 초록인 가짜 검사가 된다).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "_cursor-ties-child.ts",
);

interface Probe {
  total?: number;
  storeComposite?: number;
  storeTsOnly?: number;
  booted?: boolean;
  why?: string;
  httpSeen?: number;
  httpErr?: string;
  tail?: string;
}

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "cursor-ties-"));
  let got: Probe = {};
  let tail = "";
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
      encoding: "utf8",
      // ★90초 — 프로브 실측 5초. 종전 180초 × 2건 = 360초로 CI 예산(5분)을 넘겨,
      //  둘이 동시에 걸리면 스텝이 통째로 잘려 **1,559건 신호가 전부 사라진다**.
      timeout: 90_000,
      // 포트는 자식이 커널에서 받는다(하드코딩하면 병렬 워크트리가 물린다).
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

  const total = got.total ?? 0;
  out.push(
    assert(
      "프로브가 동률 행을 심었다(안 심었으면 아래는 무의미)",
      total > 0,
      total > 0 ? `${total}행(동률 그룹 40 × 3)` : `★심기 실패 · ${tail}`,
    ),
  );
  if (total === 0) return out;

  // ── ① 스토어 층 ────────────────────────────────────────────────────────────────
  out.push(
    assert(
      "★스토어: 복합 커서로 끝까지 페이징하면 전수 수집된다",
      got.storeComposite === total,
      `${String(got.storeComposite)}/${total}` +
        (got.storeComposite === total ? "" : " — ★동률 경계 행이 유실된다"),
    ),
  );

  // ── ② 반대편 — `ts <` 만으로는 **못 모은다**(검사가 판별력이 있는지) ────────────
  out.push(
    assert(
      "`ts <` 만으로는 전수 수집이 안 된다(이 검사가 헛돌지 않는지)",
      typeof got.storeTsOnly === "number" && got.storeTsOnly < total,
      `ts만=${String(got.storeTsOnly)}/${total}` +
        (typeof got.storeTsOnly === "number" && got.storeTsOnly < total
          ? " (유실 확인 = 판별력 있음)"
          : " — ★두 방식이 같은 결과다: 동률이 안 심겼거나 검사가 무의미하다"),
    ),
  );

  // ── ③ HTTP 층 — 브리지 핸들러가 커서를 **정말 받는가** ─────────────────────────
  out.push(
    assert(
      "프로브 데몬이 떴다",
      got.booted === true,
      got.why ?? (got.booted === true ? "부팅 확인" : `★부팅 실패 · ${tail || (got.tail ?? "")}`),
    ),
  );
  if (got.booted === true) {
    out.push(
      assert(
        "★HTTP: `/chat-history` 가 `beforeId` 를 받아 전수 수집된다",
        got.httpSeen === total,
        `${String(got.httpSeen)}/${total}` +
          (got.httpErr !== undefined && got.httpErr !== "" ? ` · ${got.httpErr}` : "") +
          (got.httpSeen === total ? "" : ` · 로그꼬리: ${got.tail ?? ""}`) +
          (got.httpSeen === total
            ? ""
            : " — ★브리지가 두 번째 축을 안 받는다(파싱 삭제·이름 오타·다른 핸들러에 붙임)"),
      ),
    );
  }
  // ── ④ **보내는 쪽** — 클라이언트가 두 축을 실제로 싣는가 (2026-08-23 4R) ────────
  //  서버·스토어에 그물을 걸어놓고 정작 커서를 **만드는 쪽**은 무방비였다: 실측으로
  //  `loadOlderHistory` 에서 `&beforeId=` 를 빼도 1,620건 전건 초록이었고 헤드리스에선
  //  52행 중 50행만 도달했다(동률 2행 영구 유실). 조립을 순수 함수로 뽑아 여기서 돌린다.
  {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../../packages/dashboard/js/history-render.js", import.meta.url),
      "utf8",
    );
    // ★**호출부도 본다** (2026-08-24 5라운드). 종전엔 추출한 함수만 돌려서, 호출부가
    //  `null` 을 넘기거나 인라인으로 되돌려도 초록이었다 — "변이로 확인" 이 함수 본문
    //  변이에만 참이었다. 두 호출부가 커서 변수를 그대로 넘기는지 확인한다.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const callSites = (
      code.match(/historyPageQuery\((?:HISTORY_PAGE|JUMP_PAGE), oldestLoadedTs, oldestLoadedId\)/g) ??
      []
    ).length;
    out.push(
      assert(
        "★두 호출부(더보기·점프)가 커서 두 축을 그대로 넘긴다",
        callSites === 2,
        `호출부 ${callSites}곳(기대 2)` +
          (callSites === 2 ? "" : " — ★null 을 넘기거나 인라인으로 되돌렸다"),
      ),
    );
    // 커서 판단 자체(순수 함수) — id 축을 죽이는 변이를 여기서 잡는다.
    const cf = /const cursorFrom = \(entries, fallbackTs\) => \{([\s\S]*?)\n      \};/.exec(src);
    if (cf !== null) {
      // eslint-disable-next-line no-new-func
      const cursorFrom = new Function(
        `return (entries, fallbackTs) => {${cf[1]}\n};`,
      )() as (e: Array<{ ts: number; id?: number }>, f: number | null) => { ts: number | null; id: number | null };
      const a1 = cursorFrom([{ ts: 5, id: 9 }], 1);
      const a2 = cursorFrom([{ ts: 5 }], 1);
      const a3 = cursorFrom([], 7);
      out.push(
        assert(
          "★커서 판단이 id 축을 살린다(entries[0].id → cursor.id)",
          a1.ts === 5 && a1.id === 9,
          JSON.stringify(a1),
        ),
        assert(
          "id 없는 배치·빈 배치에선 두 번째 축을 비운다(옛 id 를 남기지 않는다)",
          a2.id === null && a3.ts === 7 && a3.id === null,
          `${JSON.stringify(a2)} / ${JSON.stringify(a3)}`,
        ),
      );
    } else {
      out.push(assert("커서 판단 함수를 찾았다", false, "★cursorFrom 을 못 찾았다"));
    }
    // 프루닝 커서 선택 — 미래로 뛰지 않는지 **동작**으로 본다(소스 린트로는 못 잡는다).
    const vsrc = await readFile(
      new URL("../../../packages/dashboard/js/virtualization.js", import.meta.url),
      "utf8",
    );
    const vm = /const vtCursorFromNodes = \(nodes\) => \{([\s\S]*?)\n      \};/.exec(vsrc);
    if (vm !== null) {
      // eslint-disable-next-line no-new-func
      const pick = new Function(`return (nodes) => {${vm[1]}\n};`)() as (
        n: Array<{ ts: number | null; id: number }>,
      ) => { entries: Array<{ ts: number; id: number }>; fallbackTs: number } | null;
      const stepFirst = pick([
        { ts: 1000, id: Number.NaN }, // 스텝 줄(id 없음)
        { ts: 9000, id: 42 }, // 훨씬 미래의 메시지
      ]);
      out.push(
        assert(
          "★프루닝 커서는 화면 최古(1000)를 쓴다 — 미래(9000)로 뛰지 않는다",
          stepFirst !== null && stepFirst.fallbackTs === 1000 && stepFirst.entries.length === 0,
          JSON.stringify(stepFirst) +
            (stepFirst?.fallbackTs === 1000
              ? ""
              : " — ★더보기 창이 화면과 겹쳐 도구 카드·답변이 한 벌 더 그려진다"),
        ),
        assert(
          "최古 노드에 id 가 있으면 두 축을 다 쓴다",
          JSON.stringify(pick([{ ts: 5, id: 7 }])) ===
            JSON.stringify({ entries: [{ ts: 5, id: 7 }], fallbackTs: 5 }),
          JSON.stringify(pick([{ ts: 5, id: 7 }])),
        ),
      );
    } else {
      out.push(assert("프루닝 커서 함수를 찾았다", false, "★vtCursorFromNodes 를 못 찾았다"));
    }

    const m = /const historyPageQuery = \(limit, beforeTs, beforeId\) =>\n([\s\S]*?);\n/.exec(src);
    type PageQuery = (l: number, t: number | null, i: number | null) => string;
    let q: PageQuery | null = null;
    if (m !== null) {
      // eslint-disable-next-line no-new-func
      q = new Function(`return (limit, beforeTs, beforeId) =>\n${m[1]};`)() as PageQuery;
    }
    out.push(
      assert(
        "클라이언트의 커서 조립 함수를 찾았다",
        q !== null,
        q !== null ? "historyPageQuery" : "★못 찾았다 — 이름이 바뀌었거나 다시 인라인됐다",
      ),
    );
    if (q !== null) {
      const both = q(20, 1700, 42);
      const tsOnly = q(20, 1700, null);
      const first = q(20, null, null);
      out.push(
        assert(
          "★두 축을 다 아는 상태면 `beforeId` 를 **반드시** 보낸다",
          both.includes("beforeTs=1700") && both.includes("beforeId=42"),
          both,
        ),
        assert(
          "id 를 모르면 안 보낸다(빈 값·null 문자열이 새지 않는다)",
          tsOnly.includes("beforeTs=1700") && !tsOnly.includes("beforeId"),
          tsOnly,
        ),
        assert(
          "첫 페이지는 커서 없이 나간다",
          !first.includes("beforeTs") && !first.includes("beforeId"),
          first,
        ),
      );
    }
  }

  return out;
};

export const check: RegressionCheck = {
  name: "cursor-collects-ties",
  guards:
    "같은 ts 행이 페이징 경계에서 영구 유실되던 것(질문만 사라지고 답만 남음) + 그 수정에 그물이 0이라 다음 커밋이 브리지 파싱을 살아 있는 핸들러 쪽에서 지워도 1,613건이 초록이던 것(실측 20% 유실)",
  run,
};
export default check;
