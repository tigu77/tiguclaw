/**
 * 회귀: **잡 카드에 세션 이름과 원시 좌표를 나란히 두지 않는다** (2026-08-07 사용자 지적).
 *
 * 세션 이름 배지가 붙은 뒤로 카드 한 줄이 `12:03:43 · dashboard:05f08ea8-61dc-4e62-…
 * ↪ 매지프로젝트2` 가 됐다 — **같은 것을 두 번 말하면서** 읽을 수 없는 쪽이 카드를 밀어냈다.
 * 좌표는 버리지 않고 **툴팁으로** 내린다(진단할 땐 여전히 잡↔세션 대조에 필요하다).
 *
 * ★대칭이 핵심이다: 이름을 **모르면 좌표를 되살려야** 한다. 둘 다 숨기면 그 잡이 어느
 *  대화 것인지 알 길이 없어진다 — "모르는 값을 지어내지 않는다" 의 짝은 "아는 값을 숨기지
 *  않는다" 다(없는 채널 배지를 지어내던 사고의 반대편).
 *
 * 실물 `updateSessionBadge` 를 vm 에 올려 **동작으로** 본다 — 문자열 검사면 토글을 지워도
 * 초록일 수 있다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

interface Painted {
  badgeShown: boolean;
  badgeText: string;
  rawShown: boolean;
  tipHasKey: boolean;
}

const paint = (name: string, tk: string): Painted => {
  const src = readFileSync(
    path.join(REPO, "packages/dashboard/js/background-drawer.js"),
    "utf8",
  );
  const m = /const updateSessionBadge = \(entry\) => \{[\s\S]*?\n {6}\};/.exec(src);
  if (m === null) throw new Error("updateSessionBadge 를 못 찾음");
  const mk = (): Record<string, unknown> => ({
    style: { display: "?" },
    textContent: "",
    title: "",
  });
  const ctx: Record<string, unknown> = { sessionNameFor: () => name, i18n: i18nForContext };
  vm.createContext(ctx);
  vm.runInContext(`${m[0]}\nthis.__f = updateSessionBadge;`, ctx);
  const badge = mk();
  const raw = mk();
  (ctx.__f as (e: unknown) => void)({ ownerTk: tk, sessBadgeEl: badge, rawTkEl: raw });
  const disp = (el: Record<string, unknown>): string =>
    String((el.style as { display: string }).display);
  return {
    badgeShown: disp(badge) !== "none",
    badgeText: String(badge.textContent),
    rawShown: disp(raw) !== "none",
    tipHasKey: String(badge.title).includes(tk),
  };
};

export const check: RegressionCheck = {
  name: "job-card-no-raw-key",
  guards:
    "잡 카드가 세션 이름과 원시 좌표를 나란히 보여 같은 말을 두 번 하고 카드를 밀어내던 것",
  run: async (): Promise<Assertion[]> => {
    const TK = "dashboard:05f08ea8-61dc-4e62-ae2d-980a0a07d0c7";
    const named = paint("매지프로젝트2", TK);
    const unnamed = paint("", TK);

    return [
      assert(
        "★이름을 알면 배지만 보이고 원시 좌표는 숨는다(중복 표기 0)",
        named.badgeShown && !named.rawShown && named.badgeText.includes("매지프로젝트2"),
        `배지=${named.badgeShown} 좌표=${named.rawShown} "${named.badgeText}"`,
      ),
      assert(
        "숨긴 좌표는 툴팁으로 남는다(진단 시 잡↔세션 대조에 필요)",
        named.tipHasKey,
        named.tipHasKey ? "툴팁에 좌표 포함" : "툴팁에서 좌표 유실",
      ),
      assert(
        "★이름을 모르면 좌표를 되살린다(둘 다 숨기면 소속을 알 길이 없다)",
        !unnamed.badgeShown && unnamed.rawShown,
        `배지=${unnamed.badgeShown} 좌표=${unnamed.rawShown}`,
      ),
      // ★시각 자리에 **원값(epoch)** 이 오지 않는다 (2026-08-19 사용자 지적: 카드에
      //  `1787121377393` 이라는 숫자가 떠 있었다). SSE 경로는 `fmtTime(ev.ts)` 를 넘기는데
      //  하이드레이션(새로고침 복원)만 `Date.now()` 를 그대로 넘겼다 — **같은 인자에 두
      //  경로가 다른 타입**을 넣고 있었고, 새로고침한 사람에게만 보였다.
      //  그리고 "지금" 이 아니라 그 잡이 **시작한 시각**이어야 한다(서버가 startedAt 을 준다).
      (() => {
        const src = readFileSync(
          new URL("../../../packages/dashboard/js/background-drawer.js", import.meta.url),
          "utf8",
        );
        // ★**스냅샷을 화면에 반영하는 자리**를 본다. 2026-08-28(증분 5b)에 그 자리가
        //  `hydrateActiveJobs`(받아오기)와 `applyJobsSnapshot`(반영)으로 갈렸다 — 스토어가
        //  스냅샷 요청을 소유해야 합치기가 성립하기 때문이다. 함수 **이름**을 앵커로 쓰면
        //  이런 분리마다 검사가 깨지므로, 두 함수 몸통을 합쳐서 본다(지키려는 성질은
        //  "그 경로가 시각을 포맷해서 넘기는가" 이지 함수 개수가 아니다).
        const region = ["const hydrateActiveJobs", "const applyJobsSnapshot"]
          .map((anchor) => {
            const at = src.indexOf(anchor);
            if (at < 0) return "";
            const end = src.indexOf("\n      };", at);
            return end < 0 ? src.slice(at) : src.slice(at, end);
          })
          .join("\n");
        const hyd = region.trim() === "" ? "" : region;
        const rawNow = /handleWorkerEvent\([^)]*\}, Date\.now\(\)\)/.test(hyd);
        return assert(
          "★하이드레이션이 시각을 포맷해서 넘긴다(카드에 epoch 원값이 안 뜬다)",
          hyd !== "" && !rawNow && /fmtTime\(/.test(hyd) && /j\.startedAt/.test(hyd),
          hyd === ""
            ? "★하이드레이션 경로를 못 찾음(검사 전제)"
            : rawNow
              ? "★Date.now() 원값을 그대로 넘긴다"
              : "fmtTime + startedAt 확인",
        );
      })(),
      (() => {
        const bridge = readFileSync(
          new URL("../../../plugins/http-bridge/index.ts", import.meta.url),
          "utf8",
        );
        // ★**응답을 조립하는 지점**을 앵커로 잡는다. 경로 문자열(`pathname === "/worker-jobs"
        //  && method === "GET"`)은 이 파일에 **두 번** 나온다 — 위쪽 라우트 게이트 표와 실제
        //  핸들러. 첫 일치를 쓰면 게이트 표를 물어서, 응답에 필드가 있어도 없다고 판정한다
        //  (실제로 그렇게 옳은 코드가 빨간불이었다). 같은 문자열이 여러 번 나오는 파일에서
        //  "첫 일치" 는 앵커가 아니다.
        const block = /listJobs\(\{ runningOnly: true[\s\S]{0,900}/.exec(bridge)?.[0] ?? "";
        return assert(
          "서버가 startedAt 을 실어 보낸다(클라가 '지금' 으로 지어내지 않게)",
          // ★조건부 스프레드(`...(typeof j.startedAt === "number" ? { startedAt: … } : {})`)도
          //  받는다 — 첫 판이 `startedAt: j.startedAt` 한 형태만 봐서 **옳은 코드를 빨간불**로
          //  만들었다. 검사가 한 표기에 묶이면 코드를 검사에 맞추게 된다(꼬리가 개를 흔든다).
          /startedAt[^\n]{0,60}j\.startedAt/.test(block),
          /startedAt/.test(block) ? "startedAt 전달" : "★서버가 시작 시각을 안 준다",
        );
      })(),
    ];
  },
};
