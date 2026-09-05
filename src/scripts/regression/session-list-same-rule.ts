/**
 * 회귀: **세션 목록은 어디서 보든 같은 규칙이다** (2026-08-22 사용자 신고).
 *
 * 사고: 텔레그램 `/sessions` 선택지에 대시보드엔 없는 세션이 떴다. 대시보드 탭은
 *  `shouldAutoOpenTab` = `name` 이 있는 것만 여는데 텔레그램은 **전부** 뿌려서,
 *  이름 안 붙인 세션이 *첫 발화 파생 라벨*로 끼었다(`#VoxelBuilder 깃풀…` — 태그로
 *  시작하면 라벨이 아예 무의미하다). **같은 질문("어느 세션에 묶을까")에 두 화면이
 *  다른 답**을 주고 있었고, 사용자는 대시보드 쪽이 맞다고 판정했다.
 *
 * ★2026-08-09 에 폐지한 "짧은 대화 숨기기" 와 혼동하지 마라. 그건 **길이**로 추측해서
 *  갓 시작한 진짜 대화를 지웠다(관측성 훼손). 이건 **사용자가 이름을 붙였는가** —
 *  의도의 표현이지 추측이 아니다. 그래서 되살리는 조건도 사용자 손에 있다(이름 붙이기).
 *
 * ★숨기면 **숨겼다고 말해야** 한다. 조용히 접히면 사용자는 세션이 사라진 줄 안다
 *  ([[project_hotpath_bound_preserve_record]] — 캡 있는 자리의 침묵이 사고를 만든다).
 */
// ★자리가 갈렸다 (2026-09-05 구조 감사 ③): `/sessions` 본문이 진입점에서
//  `core/entry/slash-commands.ts` 로 나갔다. 검사가 지키는 성질(«같은 규칙으로 목록을
//  만든다»)은 그대로고, **읽는 자리만** 옮긴다 — 파일 이름에 묶인 검사는 다음 분해를 막는다.
import { sourceHas } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 텔레그램 선택지가 **이름 붙인 것만** 뿌린다(대시보드 탭 규칙과 동형) ─────
  {
    const w = await sourceHas("../../core/entry", [
      /const allThreads = listThreads\(\{ excludeInternal: true \}\);/,
      /\(t\.name \?\? ""\)\.trim\(\) !== "" \|\| t\.threadKey === current/,
    ]);
    out.push(
      assert(
        "★텔레그램 세션 선택지 = 이름 붙인 세션만(+ 현재 세션)",
        w.ok,
        w.ok ? "규칙 일치 확인" : `누락 ${w.missing.join(" ")}`,
      ),
    );
  }

  // ── ② ★현재 세션은 이름이 없어도 남는다 — 지금 어디 묶였는지는 보여야 한다 ────
  //  이게 빠지면 무명 세션에 묶인 사용자가 **자기 위치를 못 본다**(관측성 훼손 = 08-09
  //  에 폐지한 그 필터와 같은 병).
  {
    const w = await sourceHas("../../core/entry", [
      /\|\| t\.threadKey === current/,
    ]);
    out.push(
      assert(
        "★현재 세션은 무명이어도 목록에 남는다",
        w.ok,
        w.ok ? "현재 세션 보존 확인" : "★현재 위치가 사라진다",
      ),
    );
  }

  // ── ③ ★숨긴 개수를 말한다 + 되찾는 법을 준다 ────────────────────────────────
  {
    const w = await sourceHas("../../core/entry", [
      /const hiddenCount = allThreads\.length - threads\.length;/,
      /이름 없는 세션 \$\{hiddenCount\}개는 숨겼어요/,
    ]);
    out.push(
      assert(
        "★숨긴 개수를 말하고 되찾는 법을 준다(조용한 절삭 0)",
        w.ok,
        w.ok ? "고지 확인" : `누락 ${w.missing.join(" ")}`,
      ),
    );
  }

  // ── ④ ★안내는 **실재하는 명령만** 적는다 ────────────────────────────────────
  //  `/sessions` 하위명령은 `use|new|archive|unarchive` 뿐이다. 한때 안내에
  //  `/sessions rename` 을 적을 뻔했는데 그런 건 없다 — 사용자가 치면 막힌다.
  {
    const src = await sourceHas("../../core/entry", [/\/sessions rename/]);
    out.push(
      assert(
        "★없는 하위명령(`/sessions rename`)을 안내하지 않는다",
        !src.ok,
        !src.ok ? "실재 명령만 안내" : "★없는 명령을 안내한다",
      ),
    );
    const real = await sourceHas("../../core/entry", [
      /sub === "archive" \|\| sub === "unarchive"/,
      /sub === "use" && rest !== ""/,
      /sub === "new"/,
    ]);
    out.push(
      assert(
        "실재 하위명령 4종이 그대로 있다(use·new·archive·unarchive)",
        real.ok,
        real.ok ? "하위명령 확인" : `누락 ${real.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑤ ★보관한 세션은 **양쪽 다** 안 보인다 ──────────────────────────────────
  //  `listThreads` 기본이 `archived_at IS NULL` 이라 두 경로가 같은 답을 낸다. 이걸
  //  기본에서 빼면 대시보드에서 닫은 세션이 텔레그램에만 되살아난다(같은 부류의 재발).
  {
    const w = await sourceHas("../../store/sessions.ts", [
      /opts\?\.includeArchived !== true\) \{\s*conds\.push\("archived_at IS NULL"\)/,
    ]);
    out.push(
      assert(
        "★기본은 '보관 안 된 것만' — 대시보드에서 닫은 세션이 텔레그램에 되살아나지 않는다",
        w.ok,
        w.ok ? "보관 필터 확인" : `누락 ${w.missing.join(" ")}`,
      ),
    );
  }

  // ── ⑥ ★`/clear` 는 세션을 안 없앤다 — 그 사실과 **대안**을 같이 말한다 ────────
  //  실제로 사용자가 세션을 없애려고 `/clear` 를 썼고, 안 없어지니 같은 이름으로 새로
  //  만들어 목록에 중복이 남았다. 갈림길에서 대안을 안 주면 사용자가 우회로를 만든다.
  {
    // ★`/clear` 는 **진입점에 남아 있다** — `/` 블록 앞에서 처리되는 갈래라 옮기지 않았다.
    //  일괄로 자리를 바꾸다 이것까지 옮겨 «막다른 안내» 로 오탐이 났다(2026-09-05).
    const w = await sourceHas("../../index.ts", [
      /컨텍스트 초기화됨[\s\S]{0,200}?\/sessions archive/,
    ]);
    out.push(
      assert(
        "★`/clear` 응답이 '세션을 없애려면 archive' 를 알려준다",
        w.ok,
        w.ok ? "대안 안내 확인" : "★막다른 안내 — 사용자가 중복 세션을 만든다",
      ),
    );
  }

  return out;
};

export const check: RegressionCheck = {
  name: "session-list-same-rule",
  guards:
    "텔레그램 세션 목록엔 뜨는데 대시보드엔 없던 것(같은 질문에 두 화면이 다른 답) + 이름 없는 세션이 첫 발화 파생 라벨로 끼던 것 + `/clear` 가 세션을 안 없애는데 대안을 안 줘서 중복 세션이 생기던 것",
  run,
};
