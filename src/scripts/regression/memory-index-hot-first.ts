/**
 * 회귀: 메모리 인덱스는 **자주 쓰이는 것**을 남긴다 — "최근에 고친 것" 이 아니라.
 *
 * 사고 (2026-08-11, 프롬프트 감사 ⑩ 도달 축): 인덱스 원재료 17,449B vs 캡 8,192B = 213%,
 *  절반이 매 턴 안 실렸다. 잘리는 게 문제가 아니라 **무엇이 잘리는가**가 문제였다 —
 *  정렬이 `updated_at DESC` 라 **82회 읽힌 리포트 시각 선호**와 **69회 읽힌 뉴스 선호**가
 *  "6월 갱신" 이라는 이유로 밀려났고, **0회짜리 사실**(취미·차종)이 더 최근이라 실렸다.
 *  실측 개선: 같은 8KB 안에서 실리는 것들의 총 읽힘 1,935 → 4,952회(2.6배).
 *
 * ★이 코드는 자기 미래를 예고해 뒀다 — `bumpAccess` 주석에 "지금 당장 절단 개선에는 무효
 *  (cold-start 전량 0) — 미래 hot-first 정렬로 가는 forward 투자". 그때는 데이터가 없어
 *  미뤘고, 지금은 169건 중 163건이 읽힌 기록을 갖는다. **예고된 전환이 실제로 됐는지**를
 *  이 검사가 지킨다(주석만 남고 전환이 안 되는 것이 이 레포가 반복해 겪은 형상이다).
 *
 * 지키는 것 — ①정렬이 사용빈도 우선 ②동률·미사용은 최신순(신규가 맨 뒤로 밀리지 않게)
 *  ③캡을 넘으면 자르되 **총계는 정직하게** 보고(소실 아님을 사용자가 알 수 있게).
 */
import {
  initStore,
  getDb,
} from "../../store/sessions.js";
import { addMemory, getMemory, listMemoriesForIndex } from "../../store/memory.js";
import { assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  assertIsolated();
  const out: Assertion[] = [];
  initStore();
  const db = getDb();
  db.prepare(`DELETE FROM memories`).run();

  // 오래됐지만 **많이 쓰이는** 것 / 최근이지만 **한 번도 안 쓰인** 것.
  addMemory({ type: "user", name: "hot-old", description: "매일 아침 뉴스 선호", body: "본문" });
  addMemory({ type: "user", name: "cold-new", description: "취미는 등산", body: "본문" });
  addMemory({ type: "user", name: "warm-mid", description: "노트북은 맥북", body: "본문" });
  const setRow = (name: string, access: number, updated: number): void => {
    db.prepare(`UPDATE memories SET access_count = ?, updated_at = ? WHERE name = ?`).run(
      access,
      updated,
      name,
    );
  };
  // hot-old = 가장 오래 전 갱신인데 가장 많이 읽힘 → 종전 정렬에선 맨 뒤였다.
  setRow("hot-old", 82, 1_000);
  setRow("warm-mid", 5, 2_000);
  setRow("cold-new", 0, 9_000);

  // ── ① 출력은 **안정 순서**다 (2026-09-02) ─────────────────────────────────
  //  ★인덱스가 시스템 채널(프리픽스 캐시)로 옮겨갔다. hot-first 로 «내보내면»
  //   `read_memory` 한 번에 access_count 가 올라 순서가 바뀌고 **캐시가 깨진다**.
  //   그래서 «고르기» 만 hot-first 고 «내보내기» 는 이름순이다 — 아래 ②가 고르기를 본다.
  {
    const { lines } = listMemoriesForIndex(64 * 1024);
    const order = lines.map((l) => /\] ([a-z-]+):/.exec(l)?.[1] ?? "");
    const sorted = [...order].sort((a, b) => a.localeCompare(b));
    out.push({
      name: "★★출력이 이름순으로 **안정**하다 — 안 그러면 메모리를 읽을 때마다 캐시가 깨진다",
      ok: JSON.stringify(order) === JSON.stringify(sorted),
      got: `순서=${JSON.stringify(order)}`,
    });
  }

  // ── ①' 읽어도 텍스트가 안 바뀐다 (캐시 안정성의 실제 계약) ────────────────
  {
    const before = listMemoriesForIndex(64 * 1024).lines.join("\n");
    // ★제품 경로로 올린다(`readMemory` = 모델이 실제로 부르는 도구가 쓰는 함수) —
    //  내부 헬퍼를 export 해서 검사용 문을 새로 열지 않는다.
    getMemory("cold-new");
    const after = listMemoriesForIndex(64 * 1024).lines.join("\n");
    out.push({
      name: "★★`read_memory` 로 access_count 가 올라도 인덱스 텍스트가 **그대로**다(프리픽스 캐시 유지)",
      ok: before === after && before !== "",
      got: before === after ? "동일" : "★바뀜 — 캐시가 매 읽기마다 깨진다",
    });
  }

  // ── ② 캡을 넘으면 **적게 쓰이는 것**이 잘린다 ─────────────────────────────
  {
    // ★캡은 **가장 뜨거운 줄** 기준으로 잡는다 — 출력이 이름순이 된 뒤로 `lines[0]` 은
    //  더 이상 «가장 뜨거운 것» 이 아니다(그 전제로 짰던 옛 판이 여기서 깨졌다).
    // ★★그리고 종류별 몫(2026-09-02)이 생긴 뒤로는 **총 캡을 한 줄로 잡으면 안 된다** —
    //  `user` 몫이 총량의 10% 라 한 줄도 안 들어가 전부 잘린다(그렇게 한 번 깨졌다).
    //  여기 셋은 다 `user` 타입이므로, **그 몫이 딱 한 줄**이 되게 총 캡을 역산한다.
    const hot = listMemoriesForIndex(64 * 1024).lines.find((l) => l.includes("hot-old")) ?? "";
    const cap = Math.ceil((Buffer.byteLength(hot, "utf8") + 1) / 0.1); // user 몫 = 한 줄
    const r = listMemoriesForIndex(cap);
    out.push({
      name: "★캡 초과 시 남는 것은 가장 많이 쓰인 것",
      ok: r.lines.length === 1 && r.lines[0]?.includes("hot-old") === true,
      got: `남은 것=${r.lines.length}줄 · ${r.lines[0]?.slice(0, 40) ?? "(없음)"}`,
    });
    out.push({
      name: "잘린 수를 정직하게 보고한다(소실 아님을 알 수 있게)",
      ok: r.total === 3 && r.truncated === 2,
      got: `total=${r.total} truncated=${r.truncated} (기대 3 / 2)`,
    });
  }

  // ── ③ 신규 메모리가 0회라고 맨 뒤로 밀리지 않는다 ─────────────────────────
  //  방금 적은 것은 곧 쓰인다 — 동률(0회)끼리는 최신이 앞이어야 한다.
  {
    addMemory({ type: "user", name: "brand-new", description: "방금 적은 것", body: "본문" });
    db.prepare(`UPDATE memories SET access_count = 0, updated_at = ? WHERE name = ?`).run(
      99_999,
      "brand-new",
    );
    const { lines } = listMemoriesForIndex(64 * 1024);
    const order = lines.map((l) => /\] ([a-z-]+):/.exec(l)?.[1] ?? "");
    const iNew = order.indexOf("brand-new");
    const iCold = order.indexOf("cold-new");
    out.push({
      name: "동률(미사용)끼리는 최신이 먼저 — 신규가 즉시 묻히지 않는다",
      ok: iNew >= 0 && iCold >= 0 && iNew < iCold,
      got: `brand-new=${iNew} cold-new=${iCold} (기대 brand-new 가 앞)`,
    });
  }

  db.prepare(`DELETE FROM memories`).run();
  return out;
};

export const check: RegressionCheck = {
  name: "memory-index-hot-first",
  guards:
    "매 턴 실리는 메모리 인덱스가 updated_at 순이라 82회·69회 읽히는 사용자 선호가 밀려나고 0회짜리 사실이 실리던 것(캡 213% 초과 상태에서 무엇이 남는지가 갈렸다)",
  run,
};
