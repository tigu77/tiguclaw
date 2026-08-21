/**
 * 회귀: **모바일에서도 버전에 도달한다 + 업데이트 판정이 두 벌이 되지 않는다** (2026-08-21, 사용자 신고).
 *
 * 사고: 모바일 헤더는 46px 라 부제(`대시보드 · vX.Y.Z`)를 `display:none` 으로 숨긴다.
 * 의도된 배치였지만 **다른 노출 자리가 없어서**, 모바일 사용자는 자기가 어떤 빌드로 도는지
 * 볼 방법이 아예 없었다("모바일에서는 대시보드에 버전정보를 볼수가없네").
 *
 * ★고침은 헤더를 되살리는 게 아니라 **홈 「상태 요약」에 행을 하나 두는 것**이다 —
 *  그 패널이 이미 "지금 확인해야 할 운영 신호" 고, 모바일에서도 그대로 보인다.
 *
 * 지키는 것:
 *  ①홈에 버전 행이 있다 — 헤더가 숨겨도 **도달 경로가 남는다**
 *  ②판정이 순수 함수라 실행해서 지킬 수 있다(렌더 안이면 브라우저를 띄워야만 확인된다)
 *  ③★가장자리가 업데이트 여부를 **다시 판정하지 않는다** — `behind`·`dirty` 를 안 본다.
 *    보는 순간 칩(update-chip.js)과 판단이 두 벌이 되고, 두 벌은 갈린다
 *  ④모르면 아무 말도 안 한다 — `unknown`·미도착·새 state 는 버전만 보여준다
 *  ⑤늦게 도착한 값(버전·업데이트 판정)이 홈에 반영된다 — 안 그리면 "확인 중" 으로 굳는다
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DASH = (n: string): string =>
  readFileSync(path.join(REPO, "packages/dashboard", n), "utf8");

/** `const <name> = (` 부터 짝 맞는 `}` 까지(중괄호 깊이). */
const sliceFn = (src: string, name: string): string | null => {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) return null;
  let depth = 0;
  let seen = false;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") {
      depth++;
      seen = true;
    } else if (src[i] === "}") {
      depth--;
      if (seen && depth === 0) return `${src.slice(start, i + 1)};`;
    }
  }
  return null;
};

type Row = { tone: string; desc: string; meta: string };

export const check: RegressionCheck = {
  name: "dashboard-version-row",
  guards:
    "모바일 헤더가 버전을 숨기는데 다른 노출 자리가 없던 것 + 홈이 업데이트 여부를 스스로 다시 판정하는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const overview = DASH("js/view-overview.js");
    const chip = DASH("js/update-chip.js");
    const css = DASH("app.css");

    // 전제: 모바일 헤더는 여전히 부제를 숨긴다(숨김이 풀렸어도 홈 행은 무해하므로 경고 아님).
    const hidesSub = /header\s+\.sub[^{]*\{[^}]*display\s*:\s*none/.test(css);

    // ① 홈에 버전 행이 있다.
    const hasRow = /rows\.splice\(1, 0, \[\s*ver\.tone, "버전"/.test(overview);
    out.push(
      assert(
        "★홈 「상태 요약」에 버전 행이 있다 — 헤더가 숨겨도 도달 경로가 남는다",
        hasRow,
        `홈 행=${hasRow} · 모바일 헤더 부제 숨김=${hidesSub}`,
      ),
    );

    // ② 판정이 순수 함수로 나와 있다.
    const src = sliceFn(overview, "versionStatusRow");
    out.push(
      assert(
        "★버전 행 판정이 순수 함수다(렌더 안이면 실행 검사가 불가하다)",
        src !== null,
        src === null ? "★versionStatusRow 없음" : `${src.length}자`,
      ),
    );
    if (src === null || !hasRow) return out;

    const row = new Function(`${src}return versionStatusRow;`)() as (
      v: string,
      a: unknown,
    ) => Row;

    // ③ 가장자리가 다시 판정하지 않는다.
    const rejudges = ["behind", "dirty"].filter((k) => src.includes(k));
    out.push(
      assert(
        "★홈이 업데이트 여부를 다시 판정하지 않는다(코어가 낸 state 를 문장으로만 바꾼다)",
        rejudges.length === 0,
        rejudges.length === 0 ? "behind·dirty 미참조" : `★재판정: ${rejudges.join(", ")}`,
      ),
    );

    // 버전은 어떤 상태에서도 실린다 — 이 행이 존재하는 **이유**다.
    const states = [
      { state: "available" },
      { state: "blocked", blockedReason: "커밋 안 된 변경이 있습니다" },
      { state: "up-to-date" },
      { state: "unknown" },
      null,
    ];
    const missing = states.filter((s) => row("0.33.0", s).meta !== "v0.33.0");
    out.push(
      assert(
        "★어떤 업데이트 상태에서도 버전 자체는 표시된다",
        missing.length === 0,
        missing.length === 0
          ? `${states.length}상태 전부 v0.33.0`
          : `★누락 ${missing.length}건`,
      ),
    );

    // ④ 모르면 아무 말도 안 한다 — unknown·미도착·새 state 가 업데이트를 주장하지 않는다.
    const quiet = [{ state: "unknown" }, null, { state: "some-future-state" }];
    const noisy = quiet.filter(
      (s) => row("0.33.0", s).desc.includes("업데이트") || row("0.33.0", s).tone !== "good",
    );
    out.push(
      assert(
        "★모르면 조용하다 — unknown·미도착·모르는 state 는 업데이트를 주장하지 않는다",
        noisy.length === 0,
        noisy.length === 0 ? "3경우 전부 조용" : `★주장함: ${noisy.length}건`,
      ),
    );

    // 아는 것은 말한다 — available 은 눈에 띄고, blocked 는 코어가 준 이유를 그대로 보여준다.
    const avail = row("0.33.0", { state: "available" });
    const blocked = row("0.33.0", {
      state: "blocked",
      blockedReason: "커밋 안 된 변경이 있습니다",
    });
    out.push(
      assert(
        "받을 게 있으면 눈에 띄고, 막혔으면 코어가 준 이유를 그대로 전한다",
        avail.tone === "warn" &&
          avail.desc.includes("업데이트") &&
          blocked.desc === "커밋 안 된 변경이 있습니다",
        `available=${avail.tone} · blocked="${blocked.desc}"`,
      ),
    );

    // 버전을 아직 모를 때 0 이나 빈칸이 아니라 "모른다"고 말한다.
    out.push(
      assert(
        "버전이 아직 안 왔으면 '확인 중' 이다(빈칸으로 두지 않는다)",
        row("", null).meta === "확인 중",
        `meta="${row("", null).meta}"`,
      ),
    );

    // ⑤ 늦게 도착한 값이 홈에 반영된다 — 둘 다 같은 관용구를 쓴다.
    const RERENDER = /currentView === "overview"[\s\S]{0,40}showOverview/;
    out.push(
      assert(
        "★업데이트 판정이 도착하면 홈을 다시 그린다(안 그리면 첫 렌더 값으로 굳는다)",
        RERENDER.test(chip) && chip.includes("state: () => current"),
        `재렌더=${RERENDER.test(chip)} · state() 노출=${chip.includes("state: () => current")}`,
      ),
    );
    const activity = DASH("js/activity.js");
    out.push(
      assert(
        "★버전이 도착하면 appVersion 에 담고 홈을 다시 그린다('확인 중' 으로 굳지 않는다)",
        /appVersion = h\.version/.test(activity) && RERENDER.test(activity),
        `저장=${/appVersion = h\.version/.test(activity)} · 재렌더=${RERENDER.test(activity)}`,
      ),
    );
    return out;
  },
};
