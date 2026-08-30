/**
 * 백그라운드 카드: **서버 진실이 클라이언트 추측을 이긴다** (2026-08-20)
 *
 * 사용자 신고: "매니저가 대기중인거같은데 대시보드에서 사라진다 · 숫자는 뜨는데 잡카드는
 * 없다 · 새로고침해도 안 돌아온다 · **매니저가 에이전트보다 먼저** 사라졌다".
 *
 * 서버는 정상이었다 — 대기 중 `/worker-jobs` 가 매니저·자식을 `running` 으로 준다.
 * 문제는 클라이언트 쪽 두 줄이었다:
 *
 *  ① 하이드레이션이 "응답에 없는 running 카드 = 이미 끝난 잡" 이라고 **추측**해
 *     `interrupted` 로 찍는다. 그 부재는 경합·지연으로도 생긴다.
 *  ② 그런데 `interrupted` 가 터미널 상태 집합에 있어서, **단조성 가드**가 그 뒤로
 *     서버의 `running` 을 거부한다. 가드 자체는 옳다(재연결 replay 가 끝난 잡을 되살리던
 *     실사고에서 나왔다) — 다만 그건 **SSE replay** 에 대한 것이고, 하이드레이션은
 *     replay 가 아니라 **지금 서버가 아는 사실**이다.
 *
 *  결과: 추측이 굳고 → 진행중 필터에 숨고 → 상한 축출 대상이 되어 사라진다. 그리고
 *  서버가 옳다고 해도 안 돌아온다. 매니저가 먼저 사라지는 이유도 여기 있다 —
 *  매니저는 자식보다 **먼저 시작**해 카드 목록 아래쪽에 있고, 축출은 끝에서부터 한다.
 *
 * 등급: **소스 린트**(대시보드 JS 는 브라우저 전역 스코프 조각이라 import 해서 실행할 수
 * 없다 — 파일 경계를 넘어 자유변수를 참조하는 구조다). 그래서 **행동은 CDP 하네스**
 * (`_workspace/_bgcard_revive_cdp.mjs`)로 실증했고, 여기서는 그 판정이 코드에 남아 있는지만
 * 지킨다. ★정직하게: 동의어·우회로 뚫린다. 그래도 이 두 줄이 조용히 되돌아가는 걸 막는다.
 */
import { readFile } from "node:fs/promises";
import { readSource } from "./_wiring.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "bg-card-server-truth-wins",
  guards:
    "클라이언트가 추측으로 찍은 interrupted 가 굳어, 서버가 running 이라 해도 카드가 안 돌아오던 것 — 대기 중인 매니저가 화면에서 사라졌다 (2026-08-20)",
  run: async (): Promise<Assertion[]> => {
    const src = await readFile(
      path.join(REPO, "packages/dashboard/js/background-drawer.js"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const bridge = (
      await readSource("../../../plugins/http-bridge")
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const out: Assertion[] = [];

    out.push(
      assert(
        "★하이드레이션이 '서버가 준 것' 임을 표식한다(fromServer)",
        /fromServer:\s*true/.test(code),
        /fromServer/.test(code) ? "표식 있음" : "★없음 — 서버 진실과 replay 를 구분 못 한다",
      ),
      assert(
        "★단조성 가드가 **클라이언트 추측(interrupted)** 에는 양보한다",
        /clientGuess[\s\S]{0,200}?fromServer/.test(code),
        /clientGuess/.test(code) ? "예외 있음" : "★없음 — 추측이 서버를 이긴다",
      ),
      // ★같은 계약의 다른 축 (2026-08-24 사용자 신고: "새로고침하면 백그라운드 매니저·
      //  에이전트의 뭘 진행중인지가 사라져"). 서버는 알고 있었다 — 채팅 `/workers` 가
      //  `getJobActivity` 로 "지금 무슨 도구 몇 분째" 를 이미 보여준다. **대시보드만 못 받고
      //  있었다**: 그 한 줄이 SSE 스텝으로만 오던 터라, replay 창(50) 밖으로 밀린 긴 잡은
      //  새로고침 뒤 카드는 서고 속이 비었다.
      //  이 파일의 주제 그대로다 — **서버가 아는 것이 카드에 닿아야 한다.**
      assert(
        "★서버가 아는 '지금 무엇을 하는 중' 이 카드까지 온다(엔드포인트 → 렌더)",
        /getJobActivity\(/.test(bridge) && /activity/.test(bridge) && /renderDoing\(/.test(code),
        /getJobActivity\(/.test(bridge)
          ? /renderDoing\(/.test(code)
            ? "엔드포인트·렌더 양쪽 확인"
            : "★서버는 주는데 카드가 안 그린다"
          : "★엔드포인트가 activity 를 안 싣는다 — 채팅 /workers 만 알고 대시보드는 모른다",
      ),
      assert(
        "서버가 관측한 종료(done/failed/cancelled)는 여전히 sticky — replay 되살림 방지는 유지",
        /TERMINAL_JOB_STATUS\.has\(entry\.status\)/.test(code),
        /TERMINAL_JOB_STATUS\.has/.test(code) ? "가드 유지" : "★사라짐(옛 사고 재발)",
      ),
      assert(
        "★상태 클래스를 손목록이 아니라 정의점에서 파생한다(interrupted 가 빠져 잔여했다)",
        /classList\.remove\(\s*"running",\s*\.\.\.TERMINAL_JOB_STATUS\s*\)/.test(code),
        /classList\.remove\("running", "done"/.test(code)
          ? "★손목록으로 되돌아감 — 새 상태가 생기면 또 빠진다"
          : "파생",
      ),
      assert(
        "★원 세션 미상으로 태어난 카드는 **서버에 묻는다**(추측을 정교하게 만들지 않는다)",
        /if \(entry\.ownerTk === ""\) scheduleOwnerBackfill\(\);/.test(code),
        /scheduleOwnerBackfill/.test(code) ? "백필 있음" : "★없음 — 스코프 밖으로 숨은 채 방치된다",
      ),
      assert(
        "백필은 디바운스된다(카드가 연달아 생겨도 fetch 폭주 0)",
        /ownerBackfillTimer[\s\S]{0,200}?setTimeout/.test(code),
        /ownerBackfillTimer/.test(code) ? "디바운스 있음" : "★없음",
      ),
      assert(
        "백필이 하이드레이션과 **같은 경로**를 쓴다(서버 진실 단일 소스)",
        /scheduleOwnerBackfill[\s\S]{0,300}?hydrateActiveJobs\(\)/.test(code),
        /hydrateActiveJobs/.test(code) ? "동일 경로" : "★별도 구현",
      ),
      // interrupted 는 여전히 터미널 집합에 있어야 한다 — 진행중 필터·축출이 그걸 본다.
      assert(
        "interrupted 는 터미널 집합에 그대로 있다(부활 예외는 그 집합이 아니라 가드에서 처리)",
        /TERMINAL_JOB_STATUS\s*=\s*new Set\(\[[^\]]*"interrupted"/.test(code),
        /interrupted/.test(code) ? "포함" : "★빠짐",
      ),
    );
    return out;
  },
};
