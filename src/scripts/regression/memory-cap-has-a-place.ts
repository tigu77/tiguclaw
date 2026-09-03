/**
 * 회귀: **캡을 사람이 바꿀 자리가 있다** (2026-09-03 정태님 신고).
 *
 * ★사고: 2026-09-02 에 `memory.indexCapBytes` 를 «옵션으로 조절 가능» 이라고 내놨는데,
 *  실제로는 **`settings.json` 을 손으로 고쳐야만** 바뀌었다. 대시보드 참조 **0건**.
 *  정태님: *"설정에 메모리 인덱스 캡 사이즈 수정하는 공간이 없어."* 옵션은 있는데
 *  **사람이 쓸 자리가 없었다** — 기능이 있다고 말하려면 도달 경로가 있어야 한다.
 *
 * ★그리고 `0` 의 뜻을 바꿨다: 종전엔 «오타» 로 보고 기본값으로 되돌렸는데, 슬라이더가
 *  생기면서 0은 **도달 가능한 선택**이 됐다 — *"0이면 메모리 인덱스가 하나도 안 들어가는
 *  거고"*. 선택은 막는 게 아니라 그 뜻대로 따른다. 음수는 여전히 오타다(고를 길이 없다).
 *
 * 등급: **동작**(판정 함수 실행) + **배선**(코어→브리지→프록시→화면 사슬이 이어지나).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isMemoryIndexCapValue,
  MEMORY_INDEX_CAP_MAX,
  MEMORY_INDEX_CAP_MIN,
} from "../../core/settings.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");

export const check: RegressionCheck = {
  name: "memory-cap-has-a-place",
  guards:
    "메모리 인덱스 캡을 «옵션으로 조절 가능» 이라 내놓고 화면엔 바꿀 자리를 안 만들어, settings.json 을 손으로 고쳐야만 바뀌던 것(대시보드 참조 0건) + 0을 오타로 막아 «끄겠다는 의사» 를 표현할 수 없던 것 (2026-09-03 사용자 신고)",
  run: async (): Promise<Assertion[]> => {
    const bridge = read("plugins/http-bridge/index.ts");
    const routes = read("plugins/http-bridge/routes-settings.ts");
    const proxy = read("packages/dashboard/index.ts");
    const view = read("packages/dashboard/js/view-models.js");
    const ko = read("locales/ko.json");
    const en = read("locales/en.json");

    return [
      // ① 판정 — 실행으로 확인(경계 양옆).
      assert(
        "★★`0` 은 유효한 값이다 — «끄겠다는 의사» 를 표현할 수 있어야 한다",
        isMemoryIndexCapValue(0),
        `0→${String(isMemoryIndexCapValue(0))}`,
      ),
      assert(
        "★경계 **양옆**을 본다 — 임계 하나만 확인하면 옮기는 변이가 통과한다",
        !isMemoryIndexCapValue(MEMORY_INDEX_CAP_MIN - 1) &&
          isMemoryIndexCapValue(MEMORY_INDEX_CAP_MIN) &&
          isMemoryIndexCapValue(MEMORY_INDEX_CAP_MAX) &&
          !isMemoryIndexCapValue(MEMORY_INDEX_CAP_MAX + 1),
        `${MEMORY_INDEX_CAP_MIN - 1}✗ ${MEMORY_INDEX_CAP_MIN}✓ ${MEMORY_INDEX_CAP_MAX}✓ ${MEMORY_INDEX_CAP_MAX + 1}✗`,
      ),
      assert(
        "★음수·소수·문자는 거부 — 고를 수 없는 값이므로 오타다",
        !isMemoryIndexCapValue(-1) &&
          !isMemoryIndexCapValue(4_096.5) &&
          !isMemoryIndexCapValue("40960"),
        `-1→${String(isMemoryIndexCapValue(-1))} · 4096.5→${String(isMemoryIndexCapValue(4_096.5))} · "40960"→${String(isMemoryIndexCapValue("40960"))}`,
      ),
      // ② 배선 — 사슬이 **끊긴 데 없이** 이어지나. 한 칸만 빠져도 «자리가 없다» 로 돌아간다.
      assert(
        "★★브리지에 쓰기·조회 라우트가 있고 **write 등급**이다 — read 토큰이 설정을 바꾸면 안 된다",
        /"\/set-memory-cap" && method === "POST"[\s\S]{0,80}?"write"/.test(bridge) &&
          /pathname === "\/memory-cap" && method === "GET"/.test(bridge),
        `write등급=${String(/"\/set-memory-cap" && method === "POST"[\s\S]{0,80}?"write"/.test(bridge))} · GET라우트=${String(/pathname === "\/memory-cap" && method === "GET"/.test(bridge))}`,
      ),
      assert(
        "★핸들러가 **코어 판정을 쓴다** — 범위를 여기서 다시 쓰면 두 곳이 갈린다",
        /isMemoryIndexCapValue\(body\.bytes\)/.test(routes) &&
          /setMemoryIndexCapBytes\(/.test(routes),
        `판정=${String(/isMemoryIndexCapValue\(body\.bytes\)/.test(routes))} · 쓰기=${String(/setMemoryIndexCapBytes\(/.test(routes))}`,
      ),
      assert(
        "★★대시보드 프록시가 두 경로를 넘긴다 — 여기가 빠지면 화면에서 브리지에 못 닿는다",
        /"\/api\/set-memory-cap"/.test(proxy) && /"\/api\/memory-cap"/.test(proxy),
        `POST=${String(/"\/api\/set-memory-cap"/.test(proxy))} · GET=${String(/"\/api\/memory-cap"/.test(proxy))}`,
      ),
      assert(
        "★★★설정 화면에 **슬라이더가 실제로 붙어 있다** — 이게 이 회귀의 본체다(옵션만 있고 자리가 없던 게 사고였다)",
        /buildMemoryCapRow\(\)/.test(view) &&
          /page\.appendChild\(buildMemoryCapRow\(\)\)/.test(view) &&
          /type = "range"/.test(view),
        /page\.appendChild\(buildMemoryCapRow\(\)\)/.test(view)
          ? "슬라이더 배치됨"
          : "★만들었는데 화면에 안 붙였다",
      ),
      assert(
        "★문구가 **두 언어 다** 있다 — 한쪽만 있으면 그 언어 사용자에겐 빈 줄이 보인다",
        ["settings.memoryCap.head", "settings.memoryCap.hint", "settings.memoryCap.off"].every(
          (k) => ko.includes(k) && en.includes(k),
        ),
        `ko=${["settings.memoryCap.head","settings.memoryCap.hint","settings.memoryCap.off"].filter((k) => ko.includes(k)).length}/3 · en=${["settings.memoryCap.head","settings.memoryCap.hint","settings.memoryCap.off"].filter((k) => en.includes(k)).length}/3`,
      ),
    ];
  },
};
