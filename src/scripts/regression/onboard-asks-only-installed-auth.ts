/**
 * 회귀: **없는 구독은 묻지도 권하지도 않는다** (2026-09-01 사용자 지시).
 *
 * ★배경: v0.45.0 에서 구독 인증을 코어에서 **번들 플러그인**으로 뺐다
 *  (`claude-subscription-auth`·`codex-subscription-auth`). 그런데 `onboard`(init)·`doctor`
 *  는 **env 만 보고 무조건** 물었다 — 그 폴더를 뺀 설치(Business 판 등)에서
 *  *"Claude 구독 OAuth 를 고르세요"* · *"npm run codex-auth 로 발급하세요"* 라고 권했다.
 *  고르거나 발급해도 **등록할 플러그인이 없어 아무 일도 안 난다** — 없는 능력을 권하는
 *  상태였고, 사용자는 자기 설정을 의심하게 된다.
 *
 * ★판정은 **이름 열거가 아니라 선언**이다([[feedback_hand_maintained_lists]]) —
 *  플러그인 매니페스트의 `tiguclaw.needs.auth` 를 읽는다(`auth-plugin-presence.ts`).
 *  새 인증 플러그인이 생겨도 저절로 덮이고, 코어가 플러그인 이름을 알 필요가 없다.
 *
 * 등급: **동작** — 판정 함수를 실제로 돌려 이 레포의 매니페스트를 읽는다.
 *  + 배선(두 진입점이 그 판정을 쓰는가).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaredAuthProviders,
  subscriptionAuthAvailable,
} from "../../core/auth-plugin-presence.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "onboard-asks-only-installed-auth",
  guards:
    "구독 인증을 플러그인으로 뺀 뒤에도 onboard·doctor 가 env 만 보고 무조건 물어, 그 플러그인이 없는 설치에서 «구독 OAuth 를 고르세요»·«codex-auth 로 발급하세요» 를 권하던 것 — 고르거나 발급해도 등록할 곳이 없어 아무 일도 안 난다(사용자 지시 2026-09-01)",
  run: async (): Promise<Assertion[]> => {
    const declared = declaredAuthProviders();
    const init = readFileSync(path.join(REPO, "src/scripts/init.ts"), "utf8");
    const doctor = readFileSync(path.join(REPO, "src/scripts/doctor.ts"), "utf8");

    return [
      // ① 판정이 **실제 매니페스트**를 읽는가 — 이 레포엔 둘 다 번들돼 있다.
      assert(
        "★판정이 이 레포의 번들 플러그인 선언을 읽는다(0개면 아래는 공짜 초록이다)",
        declared.size >= 2 &&
          subscriptionAuthAvailable("claude-subscription") &&
          subscriptionAuthAvailable("codex"),
        `선언된 인증: ${[...declared].sort().join(", ") || "(없음)"}`,
      ),
      // ② 없는 id 엔 false — 술어가 «항상 참» 이면 게이트가 아무것도 안 막는다.
      assert(
        "★없는 id 엔 false 다 — 항상 참이면 게이트가 아무것도 안 막는다",
        !subscriptionAuthAvailable("존재하지-않는-인증-probe"),
        subscriptionAuthAvailable("존재하지-않는-인증-probe") ? "★항상 참" : "판별함",
      ),
      // ③ 배선 — 두 진입점이 그 판정을 **실제로 쓴다**. 판정만 있고 안 부르면 장식이다.
      assert(
        "★★`init` 이 그 판정으로 선택지를 만든다 — 안 쓰면 없는 구독을 계속 권한다",
        /declaredAuthProviders\(\)/.test(init) &&
          /has\.has\("claude-subscription"\)/.test(init) &&
          /has\.has\("codex"\)/.test(init),
        /declaredAuthProviders\(\)/.test(init) ? "판정 사용" : "★안 씀",
      ),
      assert(
        "★★`doctor` 가 그 판정으로 진단·처방을 가린다 — 없는 인증에 «발급하세요» 를 주면 사용자가 자기 설정을 의심한다",
        (doctor.match(/subscriptionAuthAvailable\(/g) ?? []).length >= 3,
        `호출 ${(doctor.match(/subscriptionAuthAvailable\(/g) ?? []).length}곳(3 이상이어야: codex 진단 · 인증 없음 안내 · 다음 단계)`,
      ),
      // ④ 번호를 **다시 매기는가** — 항목을 숨기고 번호를 고정하면 «2번은 없습니다» 를
      //   사람이 외워야 한다(숨기는 의미가 없다).
      assert(
        "★선택지 번호를 남은 항목으로 다시 매긴다 — 숨기고 번호를 고정하면 빈 번호가 생긴다",
        /all\.forEach\(\(o, i\) =>/.test(init) && /nums\.indexOf\(v\)/.test(init),
        /nums\.indexOf\(v\)/.test(init) ? "동적 번호" : "★번호 고정",
      ),
    ];
  },
};
