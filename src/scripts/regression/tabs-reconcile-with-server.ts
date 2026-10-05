/**
 * 회귀: **탭 목록이 서버와 양방향으로 맞는다** (2026-08-03 사용자 제보).
 *
 * 사용자: *"Verify 세션탭 떠있는건 뭐지?"* — 레포·DB·다른 인스턴스 어디를 뒤져도
 * `Verify` 라는 세션이 **없었다.** 브라우저 `localStorage`(`dash.tabs.v1`)에만 남은
 * **고아 탭**이었다.
 *
 * 근본: `refreshSessionPreviews` 는 서버 목록에서 **없는 탭을 추가**하고 **열린 탭을
 * 갱신**하는데, **서버가 모르는 탭을 지우지는 않았다.** `openTabs` 가 줄어드는 경로는
 * 드래그 재정렬과 사용자의 명시적 닫기뿐이었다. 그래서 세션이 사라져도(30일 프루닝·
 * 다른 기기에서 보관·다른 홈) 탭은 **그때 캐시된 이름을 단 채 영원히** 남고, 눌러도
 * 빈 대화만 나온다.
 *
 * ★같은 날 닫기를 서버 정본으로 바꾸면서(`/session-archive`) 이 구멍이 커졌다 —
 *  A 기기에서 닫으면 B 기기엔 좀비 탭이 남는다. **되살리는 쪽만 서버를 보고 지우는
 *  쪽은 안 봤다** = 한 방향만 동기화한 것이다. 내 변경이 만든 파급을 내가 안 본 사례.
 *
 * 안전장치 셋(하나라도 빠지면 멀쩡한 탭이 사라진다):
 *   ①목록이 비면 아무것도 안 지운다(로드 실패·부팅 순간을 "전부 사라짐" 으로 오독 금지)
 *   ②기본 세션은 대상 아님(닫을 수 없는 홈)
 *   ③`pending`(첫 전송 전이라 서버 행이 아직 없는 새 탭)은 건드리지 않는다
 *
 * ★2차 (같은 날): 1차는 "보고 있는 탭은 안 뺀다" 로 **활성 탭을 면제**했는데, 사용자가
 *  신고한 바로 그 탭(`verify:…`)이 **활성**이라 영구 면제가 됐다 — 새로고침해도
 *  `activeThreadKey` 가 localStorage 에서 그 탭으로 복원돼 또 면제된다. "새로고침해도
 *  보여" 가 정확히 이것이었다. 고아는 서버가 모르는 세션이라 **내용이 없으므로**
 *  기본 세션으로 옮기고 지운다. 안전장치를 다는 것과 그 장치가 **증상을 덮지 않는가**는
 *  다른 문제다 — 1차 회귀는 통과하는데 사용자 화면은 그대로였다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Tab {
  threadKey: string;
  name?: string;
  pending?: boolean;
}

/** 대시보드 JS 를 vm 에 올리고 refreshSessionPreviews 를 한 번 돌린다. */
const runRefresh = async (
  tabs: Tab[],
  serverKeys: string[],
  activeThreadKey = "dashboard:default",
  opts: { serverNames?: Record<string, string>; defaultNamed?: boolean } = {},
): Promise<{ tabs: Tab[]; active: string; names: Map<string, string>; commits: string[]; defaultNamed: boolean }> => {
  const commits: string[] = [];
  let defaultNamed = opts.defaultNamed === true;
  const src = readFileSync(path.join(REPO, "packages/dashboard/js/tabs.js"), "utf8");
  const m = /const refreshSessionPreviews = async \(\) => \{[\s\S]*?\n {6}\};/.exec(src);
  if (m === null) throw new Error("refreshSessionPreviews 를 못 찾음");
  // 활성 탭 이동은 실물 `switchToThread` 로 검사한다 — 스텁이면 "옮기고 지운다" 가 안 보인다.
  const sw = /const switchToThread = \(tk\) => \{[\s\S]*?\n {6}\};/.exec(src);
  if (sw === null) throw new Error("switchToThread 를 못 찾음");
  const openTabs = tabs.map((t) => ({ ...t }));
  const ctx: Record<string, unknown> = {
    openTabs,
    activeThreadKey,
    editingTabKey: null,
    DEFAULT_DASH_THREAD: "dashboard:default",
    MAX_SURFACED_TABS: 10,
    console: { debug: () => {}, warn: () => {} },
    fetch: () =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            sessions: serverKeys.map((k) => ({
              threadKey: k,
              displayName: `이름:${k}`,
              ...(opts.serverNames?.[k] !== undefined ? { name: opts.serverNames[k] } : {}),
            })),
          }),
      }),
    loadClosedSet: () => new Set<string>(),
    isSurfaceableSession: () => true,
    channelFromThreadKey: () => null,
    channelMeta: () => null,
    deriveTabFallbackName: (tk: string) => `세션(${tk})`,
    // 이름 고정 판정은 session-name-single-rule 이 실행으로 지킨다 — 여기선 정리 로직만 본다.
    //  ★스텁이 없으면 ReferenceError 로 루프가 죽는다: 종전엔 pending 해제 **뒤**에 던져 안 보였고,
    //   기본 탭도 부르게 되자(2026-10-05) 첫 행에서 죽어 정리 셋이 한꺼번에 빨개졌다.
    // ★판정 자체(이미 이름 있으면 안 남긴다)는 session-name-single-rule 이 실행으로 본다 — 여기선 **누구에게 몇 번 부르나**만 센다.
    commitPendingName: (tk: string, serverName: unknown) => {
      if (typeof serverName === "string" && serverName.trim() !== "") return false;
      commits.push(tk);
      return true;
    },
    defaultNameCommitted: () => defaultNamed,
    markDefaultNameCommitted: () => {
      defaultNamed = true;
    },
    persistTabs: () => {},
    renderTabBar: () => {},
    clearReply: () => {},
    loadThreadHistory: () => Promise.resolve(),
    refreshBgScope: () => {},
    // 세션 표시명 공유 지도(util.js) — 잡 카드 배지가 닫힌 세션 이름까지 알려면 이 폴이
    // 채워야 한다(2026-08-06). 여기 스텁이 없으면 refreshSessionPreviews 가 ReferenceError
    // 로 죽어 **정리 로직이 통째로 안 돈다** — 실제로 이 검사가 그렇게 잡았다.
    sessionDisplayNames: new Map<string, string>(),
    window: {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${sw[0]}\n${m[0]}\nthis.__run = refreshSessionPreviews;\nthis.__active = () => activeThreadKey;`, ctx);
  await (ctx.__run as () => Promise<void>)();
  return {
    tabs: openTabs,
    active: (ctx.__active as () => string)(),
    names: ctx.sessionDisplayNames as Map<string, string>,
    commits,
    defaultNamed,
  };
};

export const check: RegressionCheck = {
  name: "tabs-reconcile-with-server",
  guards:
    "서버에 없는 세션 탭(고아)이 캐시된 이름을 단 채 localStorage 에 영원히 남던 것 — 되살리기만 하고 지우지 않았다",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const D = "dashboard:default";
    const V = "verify:1784-abc"; // 사용자가 실제로 본 형상(배지 VERIFY = 접두에서 파생).

    // ★① 고아 제거 — 서버가 모르는 탭은 사라진다.
    const a = await runRefresh(
      [{ threadKey: D }, { threadKey: "dashboard:live" }, { threadKey: V, name: "4" }],
      [D, "dashboard:live"],
    );
    out.push(
      assert(
        "★서버가 모르는 세션 탭은 정리된다(고아 0)",
        !a.tabs.some((t) => t.threadKey === V) && a.tabs.length === 2,
        a.tabs.map((t) => t.threadKey).join(", "),
      ),
    );

    // ★② 활성 탭이 고아면 **기본 세션으로 옮기고** 지운다 — 사용자가 본 그 상태.
    //  면제만 하면 새로고침해도 activeThreadKey 가 그 탭으로 복원돼 영구히 남는다.
    const act = await runRefresh([{ threadKey: D }, { threadKey: V, name: "4" }], [D], V);
    out.push(
      assert(
        "★활성 탭이 고아면 기본 세션으로 옮기고 지운다(면제 = 영구 잔존)",
        !act.tabs.some((t) => t.threadKey === V) && act.active === D,
        `남은 탭 ${act.tabs.map((t) => t.threadKey).join(", ")} · 활성 ${act.active}`,
      ),
    );

    // ★③ 목록이 비면 아무것도 안 지운다 — 로드 실패·부팅 순간을 "전부 사라짐" 으로 읽으면
    //  사용자의 탭이 통째로 날아간다(가장 위험한 오작동).
    const b = await runRefresh([{ threadKey: D }, { threadKey: "dashboard:live" }], []);
    out.push(
      assert(
        "★서버 목록이 비면 한 개도 안 지운다(빈 응답 ≠ 세션 없음)",
        b.tabs.length === 2 && b.active === D,
        `${b.tabs.length}개 유지`,
      ),
    );

    // ★④ 첫 전송 전 새 탭(pending)은 살아남는다 — 백엔드 행이 lazy 생성이라 목록에 없다.
    //  ★활성이어도 그대로다(방금 만든 빈 탭에서 타이핑 중인데 튕기면 안 된다).
    const c = await runRefresh(
      [{ threadKey: D }, { threadKey: "dashboard:brandnew", pending: true }],
      [D],
      "dashboard:brandnew",
    );
    out.push(
      assert(
        "★첫 전송 전 새 탭은 활성이어도 안 지운다(서버 행이 아직 없을 뿐)",
        c.tabs.some((t) => t.threadKey === "dashboard:brandnew") &&
          c.active === "dashboard:brandnew",
        `${c.tabs.map((t) => t.threadKey).join(", ")} · 활성 ${c.active}`,
      ),
    );
    // 서버가 알게 되면 pending 이 풀린다 — 안 풀리면 그 탭은 영영 정리 대상 밖(고아 재발).
    const d = await runRefresh(
      [{ threadKey: D }, { threadKey: "dashboard:brandnew", pending: true }],
      [D, "dashboard:brandnew"],
    );
    out.push(
      assert(
        "서버가 알게 되면 pending 이 풀린다(영구 면제 방지)",
        d.tabs.find((t) => t.threadKey === "dashboard:brandnew")?.pending === undefined,
        JSON.stringify(d.tabs.find((t) => t.threadKey === "dashboard:brandnew")),
      ),
    );

    // ★⑥ 세션 표시명이 **열린 탭 여부와 무관하게** 공유 지도에 담긴다 (2026-08-06).
    //  백그라운드 잡 카드가 "이 잡이 어느 세션 것인가" 를 사람 이름으로 보여주려면 **안 연
    //  세션**의 이름이 필요하다(잡은 대개 다른 세션에서 띄워놓고 잊은 것이다). 이 폴이
    //  유일한 채우는 곳이라, 여기서 빠지면 배지는 영영 비어 있고 아무도 모른다.
    const nm = await runRefresh([{ threadKey: D }], [D, "dashboard:notopen"]);
    out.push(
      assert(
        "★세션 표시명이 열지 않은 세션까지 공유 지도에 담긴다(잡 카드 배지의 유일한 소스)",
        nm.names.get("dashboard:notopen") === "이름:dashboard:notopen" &&
          nm.names.get(D) === `이름:${D}`,
        `${nm.names.size}건: ${[...nm.names.keys()].join(", ")}`,
      ),
    );

    // ★⑦ 기본 세션 이름은 **한 번만** 남긴다 (2026-10-05). 기본 탭은 pending 이 된 적이 없어 갱신 루프가 따로 부른다.
    //  — 안 부르면 기본 세션은 영영 이름이 없고, 매 폴 «비어 있으면» 으로 부르면 사용자가 일부러 비운 이름이 «세션1» 로 되덮인다.
    //  ★다른 열린 탭(검색으로 연 것·자동 노출)은 부르지 않는다 — 부르면 첫 발화로 정해지던 이름이 모든 채널에서 «세션N» 으로 바뀐다.
    {
      const first = await runRefresh([{ threadKey: D }, { threadKey: "dashboard:opened" }], [D, "dashboard:opened"]);
      const seen = await runRefresh([{ threadKey: D }], [D], D, { serverNames: { [D]: "세션1" } });
      const cleared = await runRefresh([{ threadKey: D }], [D], D, { defaultNamed: true });
      out.push(
        assert(
          "★기본 세션 이름이 비어 있으면 처음 한 번 남기고, 이름 없는 다른 열린 탭엔 손대지 않는다",
          first.commits.length === 1 && first.commits[0] === D &&
            // «남겼다» 는 요청 시점이 아니라 서버에 이름이 보인 뒤 — 요청이 실패하면 다음 폴이 다시 남겨야 한다(재검토 M9).
            first.defaultNamed === false,
          `부른 대상: ${JSON.stringify(first.commits)}`,
        ),
      );
      out.push(
        assert(
          "★서버에 이름이 보이면 «남겼다» 로 기록하고, 그 뒤 이름이 비어도(사용자가 비움) 다시 덮지 않는다",
          seen.commits.length === 0 && seen.defaultNamed && cleared.commits.length === 0,
          `이름 보임→기록=${seen.defaultNamed}·부름 ${seen.commits.length} · 비운 뒤 부름 ${cleared.commits.length}`,
        ),
      );
    }

    // ★⑤ 서버가 아는 탭은 활성이든 아니든 그대로 — 과잉 정리 0.
    const e = await runRefresh(
      [{ threadKey: D }, { threadKey: "dashboard:live" }],
      [D, "dashboard:live"],
      "dashboard:live",
    );
    out.push(
      assert(
        "서버가 아는 탭은 건드리지 않는다(과잉 정리 0)",
        e.tabs.length === 2 && e.active === "dashboard:live",
        e.tabs.map((t) => t.threadKey).join(", "),
      ),
    );
    // ★⑧ 탭 이름 편집 중엔 다시 그리지 않는다 (2026-10-05 적대 검토). 다시 그리면 포커스된 편집칸이 지워지는데 blur 가
    //  안 와서 편집이 «열린 채» 잠긴다(새로고침 전까지 이름 변경 전부 불가). 부르는 쪽이 여럿(턴 변화·이름 저장·폴)이라
    //  렌더 자신이 미룬다 — 그 성질을 실제 함수로 잰다.
    {
      const src = readFileSync(path.join(REPO, "packages/dashboard/js/tabs.js"), "utf8");
      const m = /let tabBarDeferred = false;\s*const renderTabBar = \(\) => \{[\s\S]*?\n {6}\};/.exec(src);
      if (m === null) {
        out.push(assert("renderTabBar 를 떼어낸다(검사 전제)", false, `★tabs.js ${src.length}자에서 못 찾음`));
      } else {
        const strip = { innerHTML: "EDITING", appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [], clientWidth: 0 };
        const ctx: Record<string, unknown> = { sessionTabsEl: strip, editingTabKey: "dashboard:default", openTabs: [] };
        vm.createContext(ctx);
        vm.runInContext(`${m[0]}\nthis.__render = renderTabBar; this.__deferred = () => tabBarDeferred;`, ctx);
        // 미루지 않으면 실제로 그리려다 DOM 이 없어 던진다 — 그것도 «편집 중에 그렸다» 는 뜻이라 단언으로 받는다.
        let threw = "";
        try {
          (ctx.__render as () => void)();
        } catch (e) {
          threw = e instanceof Error ? e.message : String(e);
        }
        const deferred = threw === "" && (ctx.__deferred as () => boolean)();
        out.push(
          assert(
            "★편집 중엔 탭 바를 다시 그리지 않고 «미뤘다» 고 남긴다(편집칸이 지워지면 편집이 잠긴다)",
            strip.innerHTML === "EDITING" && deferred,
            `innerHTML=${JSON.stringify(strip.innerHTML)} · 미룸=${deferred}${threw === "" ? "" : ` · ★그리려 했다(${threw})`}`,
          ),
        );
        const finishSrc = /const finish = \(commit\) => \{[\s\S]*?\n {8}\};/.exec(src)?.[0] ?? "";
        out.push(
          assert(
            "편집이 끝나면 미룬 렌더를 마저 한다",
            /if \(tabBarDeferred\) renderTabBar\(\)/.test(finishSrc),
            finishSrc === "" ? "★finish 못 찾음" : `finish ${finishSrc.length}자 · 미룬 렌더=${/if \(tabBarDeferred\) renderTabBar\(\)/.test(finishSrc)}`,
          ),
        );
      }
    }
    return out;
  },
};
