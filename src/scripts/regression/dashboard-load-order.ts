/**
 * 회귀: **부팅 렌더 경로가 나중에 로드되는 식별자를 쓰지 않는다** (2026-07-31 3차 검토).
 *
 * 사고: `fmtBytes` 가 `chat-send.js`(로드 #29)에 있는데 `history-render.js`(#18)가 썼다.
 * 클래식 스크립트의 top-level `const` 는 스크립트끼리 공유되지만 **실행 전에는 TDZ** 다.
 * 그런데 `tabs.js`(#25)가 top-level 에서 `loadChatHistory()` 를 부르고, 그 fetch 가
 * `chat-send.js` 로드보다 먼저 끝나면 렌더 도중 `ReferenceError` 가 나고 `catch` 가 그것을
 * 삼켜 **채팅이 통째로 백지**가 됐다. 라이브 실측으로 경합 창이 **항상** 열려 있었다
 * (`/api/chat-history` 214ms vs `/js/chat-send.js` 376ms). 최근 20건에 `bytes` 를 가진
 * 첨부가 하나만 있어도 발동했다.
 *
 * ★왜 이 검사인가: 원인은 "이름 하나를 옮기는 것" 이 아니라 **로드 순서가 곧 계약**이라는
 *  구조다. 이름을 열거해 지키면 다음 이름을 빠뜨린다(손으로 관리하는 목록). 그래서
 *  `index.html` 의 실제 로드 순서를 읽어 **부팅 렌더 경로의 전방 참조 0** 을 판정한다.
 *
 * 범위: 부팅 async 연속(`loadChatHistory()`)이 동기로 부르는 렌더러만 본다. 다른 파일의
 *  전방 참조는 사용자 상호작용 뒤에야 실행되므로(그때는 전부 로드됨) 여기 대상이 아니다 —
 *  과잉 방어로 정상 구조를 깨지 않기 위해 의도적으로 좁혔다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

/** 부팅 async 연속이 동기로 렌더하는 파일 — 여기서만 전방 참조가 사고가 된다. */
const BOOT_RENDER_FILES = ["history-render.js"];

const DEF_RE = /^\s*(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

export const check: RegressionCheck = {
  name: "dashboard-load-order",
  guards:
    "부팅 이력 렌더가 나중 스크립트의 함수를 써서 ReferenceError → 채팅 화면이 통째로 백지가 되던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../packages/dashboard",
    );
    const html = await readFile(path.join(root, "index.html"), "utf8");
    const order = [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map(
      (m) => m[1],
    );
    out.push(
      assert(
        "index.html 에서 스크립트 로드 순서를 읽는다(검사 전제)",
        order.length > 10,
        `${order.length}개`,
      ),
    );

    // 이름 → 최초 정의 위치(로드 순서 인덱스).
    const defs = new Map<string, { idx: number; file: string }>();
    for (const [i, f] of order.entries()) {
      const src = await readFile(path.join(root, "js", f), "utf8").catch(() => "");
      for (const m of src.matchAll(DEF_RE)) {
        if (!defs.has(m[1])) defs.set(m[1], { idx: i, file: f });
      }
    }

    for (const target of BOOT_RENDER_FILES) {
      const ti = order.indexOf(target);
      if (ti < 0) {
        out.push(assert(`${target} 이 로드 목록에 있다`, false, "미등재"));
        continue;
      }
      const src = await readFile(path.join(root, "js", target), "utf8");
      const used = new Set([...src.matchAll(CALL_RE)].map((m) => m[1]));
      const late = [...used]
        .map((n) => ({ n, d: defs.get(n) }))
        .filter((x) => x.d !== undefined && x.d.idx > ti)
        .map((x) => `${x.n}→${x.d?.file}(#${(x.d?.idx ?? 0) + 1})`);
      out.push(
        assert(
          `★${target}(#${ti + 1}) 가 쓰는 것은 전부 더 앞에서 정의된다(TDZ 백지 0)`,
          late.length === 0,
          late.length === 0
            ? `호출 식별자 ${used.size}개 · 전방 참조 0`
            : `★전방 참조 ${late.length}건: ${late.join(" ")}`,
        ),
      );
    }

    // 대조군 — 이 검사가 실제로 뭔가를 보고 있다는 증거(정의 지도가 비면 위 단언은 공짜다).
    out.push(
      assert(
        "대조군 — 정의 지도가 비어 있지 않다(공짜 통과 아님)",
        defs.size > 100 && defs.has("escHtml") && defs.has("fmtBytes"),
        `정의 ${defs.size}개 · escHtml=${defs.get("escHtml")?.file ?? "없음"} · fmtBytes=${defs.get("fmtBytes")?.file ?? "없음"}`,
      ),
    );
    return out;
  },
};
