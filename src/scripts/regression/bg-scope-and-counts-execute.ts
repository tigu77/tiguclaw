/**
 * 백그라운드 드로어의 **판정을 실행해서** 본다 — 스코프·카운트·경과시간 (2026-08-20)
 *
 * 잡는 회귀 — 전체 검토(면적 C):
 *  - 이 파일(1,161줄)을 읽는 검사 5개가 **전부 정규식 소스 린트**였고, 오늘 넣은 픽스조차
 *    변이 6건 중 5건이 통과했다. `entry.` 한 단어를 지우거나 `true` → `"true"` 로 바꾸면
 *    예외가 영영 발동 안 하는데 초록이었다.
 *  - `refreshBgBadge`·`isBgInScope`·`jobOwnerSession`·`fmtElapsed`·`startTs` 는 회귀
 *    172개 파일 전체에서 **한 번도 언급되지 않았다.**
 *
 * ★기법은 이 레포에 이미 있다(`working-elapsed-own-session.ts`) — 함수 본문을 뽑아
 *  `node:vm` 에서 돌린다. 브라우저 0, 수십 ms. 문자열이 아니라 **행동**을 지킨다.
 *
 * 지키는 규칙 셋:
 *  ① 세션 스코프 판정은 **fail-closed** 다(모르면 남의 것으로 본다).
 *  ② 헤더 배지(전역)와 드로어 카운트(세션)의 **차이를 화면이 말한다** — 빈 메시지가
 *    "없습니다" 로 단정하면 사용자는 배지 숫자와 대조할 수 없다(오늘 신고의 모양).
 *  ③ 경과시간 기준은 **서버가 준 `startedAt`** 이다 — 클라가 "지금" 으로 지어내면
 *    2시간째 도는 매니저가 새로고침 후 "0s" 로 보인다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck, JS_I18N_STUB } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = path.join(REPO, "packages/dashboard/js/background-drawer.js");

/** 함수 본문을 이름으로 뽑는다 — 6칸 들여쓰기 종결(이 파일의 조각 규약). */
const extract = (src: string, name: string): string => {
  const re = new RegExp(
    `      const ${name} = \\([^)]*\\) => \\{[\\s\\S]*?\\n      \\};`,
  );
  const m = re.exec(src);
  if (m === null) throw new Error(`${name} 을 못 찾음 — 시그니처가 바뀌었나`);
  return m[0];
};

export const check: RegressionCheck = {
  name: "bg-scope-and-counts-execute",
  guards:
    "드로어 스코프·카운트·경과시간 판정이 소스 린트로만 지켜져 의미를 바꾸는 변이가 전부 통과하던 것 (2026-08-20 전체 검토 C)",
  run: async (): Promise<Assertion[]> => {
    const src = readFileSync(SRC, "utf8");
    const out: Assertion[] = [];

    // ── ① 세션 스코프 — fail-closed ─────────────────────────────────────────────
    //  2026-07-28 사고(사용자 신고 2회): 소속 미상을 "모든 세션 것" 으로 취급해 **남의
    //  세션에도 진행 중으로 떴다**. 모르면 내 것이 아니다.
    {
      const ctx: Record<string, unknown> = {
        activeThreadKey: "dashboard:mine",
        jobCards: new Map<string, unknown>([
          ["j-own", { threadKey: "dashboard:mine", ownerTk: "" }],
          ["j-other", { threadKey: "dashboard:theirs", ownerTk: "" }],
        ]),
      };
      vm.createContext(ctx);
      vm.runInContext(
        `${extract(src, "jobOwnerSession")}\n${extract(src, "isBgInScope")}\n` +
          `this.__scope = isBgInScope; this.__owner = jobOwnerSession;`,
        ctx,
      );
      const scope = ctx.__scope as (tk: string, owner?: string) => boolean;
      out.push(
        assert("내 세션 잡은 스코프 안", scope("dashboard:mine", ""), "true 여야"),
        assert("남의 세션 잡은 스코프 밖", !scope("dashboard:theirs", ""), "false 여야"),
        assert(
          "★소속 미상은 **남의 것**으로 본다(fail-closed) — 모르면 안 보여준다",
          !scope("worker:unknown-parent", ""),
          "false 여야 — true 면 남의 세션에도 뜬다(2026-07-28 사고)",
        ),
        assert(
          "서버가 준 원 세션(ownerTk)이 1순위 — 프런트 추측보다 이긴다",
          scope("worker:whatever", "dashboard:mine"),
          "true 여야",
        ),
      );
    }

    // ── ② 배지(전역) ↔ 드로어(세션)의 차이를 화면이 말하는가 ─────────────────────
    //  오늘 신고: "숫자는 2인데 카드가 없다". 배지는 전역이고 목록은 세션 스코프라
    //  **둘이 다를 수 있는 건 설계**다. 문제는 빈 메시지가 "없습니다" 로 **단정**하는 것 —
    //  그러면 사용자가 두 숫자를 대조할 수 없고 뭘 믿어야 할지 모른다.
    {
      const el = (): Record<string, unknown> => ({
        textContent: "",
        hidden: false,
        classList: { toggle: () => {}, add: () => {}, remove: () => {} },
        style: {},
      });
      const bgBadge = el(), bgCountRunning = el(), bgCountAll = el(), bgEmpty = el();
      const ctx: Record<string, unknown> = {
        activeThreadKey: "dashboard:mine",
        bgSessionScope: "session",
        bgBadge, bgCountRunning, bgCountAll, bgEmpty,
        bgStatusFilter: null,
        bgFilter: "running", // 상태 필터(진행중/완료) — 빈 메시지 문구 판정에 쓰인다.
        jobCards: new Map<string, unknown>([
          // 남의 세션에서 **도는** 잡 — 사용자가 오늘 본 상태(배지엔 세지고 목록엔 없다).
          ["j-other", { status: "running", threadKey: "dashboard:theirs", ownerTk: "dashboard:theirs" }],
          // ★내 세션의 **끝난** 잡 — 배지는 "진행 중" 개수이므로 이건 세면 안 된다.
          //  섞어두지 않으면 "종료된 잡도 센다" 는 변이가 같은 숫자를 내 통과한다.
          ["j-done", { status: "done", threadKey: "dashboard:mine", ownerTk: "dashboard:mine" }],
        ]),
        shellCards: new Map(),
        document: { getElementById: () => null },
        chatBgActiveEl: el(),
        jobOwnerSession: () => "",
        isShellInScope: () => false,
        i18n: (v: string) => v,
      };
      vm.createContext(ctx);
      try {
        vm.runInContext(
          `${extract(src, "jobOwnerSession")}\n${extract(src, "isBgInScope")}\n` +
            `${extract(src, "refreshBgBadge")}\nthis.__refresh = refreshBgBadge;`,
          ctx,
        );
        (ctx.__refresh as () => void)();
        const badge = String((bgBadge as { textContent: string }).textContent);
        const scoped = String((bgCountRunning as { textContent: string }).textContent);
        out.push(
          assert(
            "헤더 배지는 **전역**이라 남의 세션 잡도 센다(설계 — 여기까진 정상)",
            badge === "1",
            `배지=${badge}`,
          ),
          assert(
            "★배지는 **진행 중**만 센다 — 끝난 잡까지 세면 사용자가 없는 작업을 찾아 헤맨다",
            badge === "1",
            `배지=${badge} (진행중 1 · 완료 1 이므로 1이어야)`,
          ),
          assert(
            "드로어 카운트는 **세션 스코프** 라 0 이다(설계)",
            scoped === "0",
            `세션 카운트=${scoped}`,
          ),
          // ★이 단언은 **절대 실패할 수 없었다** (2026-08-20 재검토 F3). `/작업이 없습니다$/`
          //  의 `$` 앵커가 제품 문구의 **마침표** 때문에 영영 안 맞아, 앞의 `!` 가 항상 참이었다.
          //  즉 제품이 종전대로 단정해도 초록이었다 — "항상 초록인 가짜 검사" 의 교과서적 예다.
          //  이제 **말해야 할 내용**을 직접 요구한다: 다른 데 몇 개 있는지.
          assert(
            "★둘이 갈릴 때 빈 메시지가 '없습니다' 로 단정하지 않고 **어디에 있는지** 말한다",
            /다른 대화/.test(String((bgEmpty as { textContent: string }).textContent)) &&
              /1개/.test(String((bgEmpty as { textContent: string }).textContent)),
            String((bgEmpty as { textContent: string }).textContent) || "(빈 문자열)",
          ),
        );
      } catch (e) {
        out.push(
          assert(
            "refreshBgBadge 를 실행할 수 있다(추출 실패 시 이 검사가 무력해진다)",
            false,
            e instanceof Error ? e.message.slice(0, 120) : String(e),
          ),
        );
      }
    }

    // ── ③ 경과시간 기준 = 서버가 준 startedAt ───────────────────────────────────
    //  실측: 서버는 `/worker-jobs` 로 `startedAt` 을 주는데 클라가 **시각 표기에만** 썼고
    //  경과시간 기준은 `Date.now()` 였다 → 2시간째 도는 매니저가 새로고침 후 "0s".
    //  옆 레인(`view-shells.js`)은 처음부터 서버값을 쓴다 — 같은 화면에서 갈렸다.
    {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

      // ★생산자도 본다 (2026-08-20 재검토 F1). 이 검사는 **카드 생성부만** 봐서,
      //  `startedAt` 을 쓰도록 고쳐놓고 **호출부가 그 필드를 안 넘기던 것**을 초록으로
      //  통과시켰다 — 픽스가 통째로 무동작인데 그물은 "지켜졌다" 고 말했다.
      //  같은 부류를 오늘만 네 번째 반복한다: **소비자를 보고 생산자를 가정한다.**
      //  그래서 문자열이 아니라 **호출부 인자식을 실제로 평가**한다.
      const sites = [...code.matchAll(/ensureJobCard\(\s*[\w.]+\s*,\s*(\{[^;]*?\})\s*\)/g)];
      const carries = sites.map((m) => {
        try {
          const f = new Function("p", "ts", "cardOpts", `${JS_I18N_STUB}return (${m[1]});`);
          const probe = { jobId: "j", startedAt: 1_700_000_000_000, label: "l" };
          return (f(probe, "t", probe) as { startedAt?: number }).startedAt === 1_700_000_000_000;
        } catch {
          return false; // 평가 못 하는 형태면 보증 못 함 → fail-closed.
        }
      });
      out.push(
        assert(
          "★lifecycle 호출부가 서버의 startedAt 을 **카드까지 실어 보낸다** — 여기서 버리면 아래 픽스가 무동작",
          carries.length >= 2 && carries.filter(Boolean).length >= 2,
          `호출부 ${carries.length}곳 중 ${carries.filter(Boolean).length}곳 전달`,
        ),
        assert(
          "★카드 생성이 서버의 startedAt 을 경과시간 기준으로 받는다",
          /startTs:\s*\n?\s*opts && typeof opts\.startedAt === "number" \? opts\.startedAt : Date\.now\(\)/.test(
            code,
          ),
          /startTs: Date\.now\(\)/.test(code)
            ? "★무조건 Date.now() — 새로고침하면 0s 로 리셋된다"
            : "서버값 사용",
        ),
        assert(
          "경합 가드는 **카드 생성 시각**(createdTs)을 쓴다 — startTs 와 축이 다르다",
          /createdTs/.test(code) && /e\.createdTs \|\| e\.startTs/.test(code),
          /createdTs/.test(code) ? "분리됨" : "★같은 값을 두 질문에 쓴다",
        ),
      );
    }

    return out;
  },
};
