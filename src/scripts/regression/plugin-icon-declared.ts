/**
 * 회귀: **아이콘은 선언하고, 없으면 기본** (2026-09-02 정태님: *"아이콘 필드가 있어야지 /
 * 비어있으면 그냥 기본 아이콘으로 사용하자는거지"*).
 *
 * ★목록 행이 «아이콘 · 이름 · 설명» 만 두기로 하면서 아이콘이 필수가 됐다. 그런데 아이콘은
 *  **플러그인 폴더의 파일을 브라우저로 내보내는 문**이라 새 표면이다 — 그래서 세 겹으로 막는다:
 *  ① 매니페스트 파서가 `..`·절대경로·비래스터를 **애초에 안 담는다**
 *  ② 서빙이 심링크를 풀고 플러그인 폴더 안인지 다시 본다(첨부 서빙이 심링크로 한 번 뚫렸다)
 *  ③ content-type 을 확장자 고정 표로 정한다
 *
 * ★★**SVG 를 안 받는다.** 같은 오리진에 `/api/messages`(= 비서에게 임의 지시)가 있는데,
 *  서드파티가 넣은 SVG 는 그 오리진에서 스크립트를 돌릴 수 있다. 아이콘 하나를 위해 열 문이
 *  아니다 — 기본 아이콘은 우리가 그린 인라인 SVG 다(파일이 아니라 코드).
 *
 * 등급: **동작**(파서를 실제로 돌린다) + **판정**(서빙·화면 배선).
 */
import { readPluginMeta } from "../../core/plugins/loader.js";
import { readSourceSync } from "./_wiring.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const meta = (icon: unknown): { icon?: string } =>
  readPluginMeta({ name: "p", tiguclaw: { icon } } as Record<string, unknown>);

export const check: RegressionCheck = {
  name: "plugin-icon-declared",
  guards:
    "플러그인 아이콘 필드를 열면서 생기는 것들 — 경로 탈출(`../`)·절대경로로 폴더 밖 파일이 나가는 것 + 서드파티 SVG 가 대시보드 오리진에서 스크립트를 돌리는 것 + 선언이 없을 때 목록에 빈 칸이 생기는 것(2026-09-02)",
  run: async (): Promise<Assertion[]> => {
    const files = readSourceSync("plugins/http-bridge/routes-files.ts");
    const view = readSourceSync("packages/dashboard/js/view-plugins.js");
    const bridge = readSourceSync("plugins/http-bridge/index.ts");

    return [
      assert(
        "★래스터 아이콘은 받는다(png·webp) — 이게 0이면 아래 거절들은 공짜 초록이다",
        meta("icon.png").icon === "icon.png" && meta("a/b.webp").icon === "a/b.webp",
        `png=${String(meta("icon.png").icon)} · webp=${String(meta("a/b.webp").icon)}`,
      ),
      assert(
        "★★경로 탈출·절대경로를 **애초에 안 담는다** — 담아두면 읽는 쪽 실수 하나로 폴더 밖이 나간다",
        meta("../../.env").icon === undefined &&
          meta("/etc/passwd").icon === undefined &&
          meta("a/../../b.png").icon === undefined,
        `up=${String(meta("../../.env").icon)} · abs=${String(meta("/etc/passwd").icon)} · mid=${String(meta("a/../../b.png").icon)}`,
      ),
      assert(
        "★★SVG 를 안 받는다 — 같은 오리진에 `/api/messages` 가 있어 서드파티 SVG 는 스크립트 실행 벡터다",
        meta("icon.svg").icon === undefined && meta("icon.SVG").icon === undefined,
        `svg=${String(meta("icon.svg").icon)}`,
      ),
      assert(
        "★이상한 값은 조용히 없는 것으로 — 하나 잘못 적었다고 플러그인이 안 뜨면 과하다",
        meta(undefined).icon === undefined &&
          meta(42).icon === undefined &&
          meta("").icon === undefined,
        `undefined=${String(meta(undefined).icon)} · 숫자=${String(meta(42).icon)} · 빈문자=${String(meta("").icon)}`,
      ),
      assert(
        "★★서빙이 심링크를 풀고 **플러그인 폴더 안인지 다시** 본다(첨부 서빙이 그렇게 한 번 뚫렸다)",
        /realpathSync\(found\.pluginDir\)/.test(files) &&
          /real !== realDir && !real\.startsWith\(realDir \+ path\.sep\)/.test(files),
        /realpathSync\(found\.pluginDir\)/.test(files) ? "심링크 해소 후 재검사" : "★접두 비교만",
      ),
      assert(
        "★content-type 을 **파일이 정하지 못한다**(확장자 고정 표)",
        /endsWith\(".webp"\) \? "image\/webp" : "image\/png"/.test(files),
        /image\/webp/.test(files) ? "고정 표" : "★파일이 정한다",
      ),
      assert(
        "★선언이 없으면 **404** — 여기서 기본 아이콘을 대신 주면 «선언 안 함» 과 «파일 없음» 이 구분되지 않는다",
        /no icon/.test(files) && /"\/plugin-icon" && method === "GET"[\s\S]{0,120}?"read"/.test(bridge),
        /no icon/.test(files) ? "404 + read 게이트" : "★기본을 대신 준다",
      ),
      assert(
        "★★화면은 선언이 있을 때만 그 플러그인 파일을 받고, 실패하면 **기본 아이콘으로 떨어진다**(빈 칸은 «망가졌다» 로 읽힌다)",
        /p\.meta\.icon === "string"/.test(view) &&
          /addEventListener\("error"[\s\S]{0,120}?pluginIconImg\(\)/.test(view),
        /addEventListener\("error"/.test(view) ? "폴백 있음" : "★폴백 없음",
      ),
      assert(
        "★★목록 행에는 **아이콘·이름·설명만** 있다 — 버튼이 붙으면 «고르는 화면» 이 «다루는 화면» 이 된다",
        /plugin-item-icon/.test(view) &&
          /plugin-item-name/.test(view) &&
          /plugin-item-desc/.test(view) &&
          !/buildPluginListRow[\s\S]{0,1400}?settings-toggle/.test(view),
        /buildPluginListRow[\s\S]{0,1400}?settings-toggle/.test(view) ? "★행에 버튼이 있다" : "아이콘·이름·설명뿐",
      ),
    ];
  },
};
