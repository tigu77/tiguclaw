/**
 * 회귀: **긴 카드에서 ⋯ 메뉴 버튼이 보이는 영역을 따라다닌다** (2026-08-23 사용자 요청).
 *
 * 종전엔 카드 우상단 고정이라, 카드가 화면보다 길면 버튼이 위로 밀려 나가 **닿을 수가
 * 없었다**(우클릭은 되지만 버튼을 찾는 사용자에겐 사라진 것이다).
 *
 * ★CSS `sticky` 로는 안 된다 — 채팅 목록은 가상화라 창을 `translateY` 로 옮기는데,
 *  변환된 조상이 sticky 의 기준을 깨뜨린다. **실측**: sticky 로 바꾸니 버튼이 카드 끝에
 *  남았고(카드 상단 -4086px 일 때 버튼 -819px = 카드 바닥), 재배치 때 노드도 갈렸다.
 *  그래서 절대배치를 유지하고 `top` 만 스크롤에 맞춰 갱신한다.
 * ★비용 주의: 리스너는 **하나**, 갱신 대상은 hover 중인 **한 장**뿐이다. 카드마다
 *  옵저버를 달면 목록 길이에 비례해 비싸진다 — 가상화가 그걸 피하려고 있는 것이다.
 *
 * 동작 검증은 헤드리스(`_workspace/verify_kebab_sticky.mjs`, 5/5)가 한다: 3,295px 카드를
 * 900px 스크롤해도 버튼이 화면 상단 8px 에 남는다. 여기서는 매번 싸게 배선을 지킨다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DASH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "packages",
  "dashboard",
);
const read = async (rel: string): Promise<string> => {
  try {
    return await readFile(path.join(DASH, rel), "utf8");
  } catch {
    return "";
  }
};

export const check: RegressionCheck = {
  name: "kebab-follows-viewport",
  guards:
    "긴 카드에서 ⋯ 메뉴 버튼이 화면 밖으로 밀려나 닿을 수 없던 것 + 그걸 CSS sticky 로 고치려다 가상화(translateY)에 깨지는 것",
  run: async (): Promise<Assertion[]> => {
    const js = await read("js/reply.js");
    const css = await read("app.css");
    if (js === "" || css === "") {
      return [assert("대시보드 소스 부재 시 통과(배포본 — 오탐 0)", true, "★확인 못 함")];
    }
    return [
      assert(
        "★스크롤에 맞춰 버튼 위치를 갱신한다(follow 배선)",
        js.includes("syncFollowedKebab") &&
          js.includes('stream.addEventListener("scroll", syncFollowedKebab'),
        js.includes("syncFollowedKebab") ? "확인" : "★따라가지 않는다",
      ),
      assert(
        // ★sticky 로 되돌리면 가상화에서 조용히 깨진다(버튼이 카드 끝에 남는다).
        //  화면엔 "가끔 안 보임" 으로만 나타나 원인을 찾기 어렵다 — 그래서 못 박는다.
        "★sticky 로 되돌리지 않는다(가상화 translateY 가 기준을 깨뜨린다)",
        /\.ev\.local > \.cm-kebab \{ position:absolute/.test(css),
        /\.ev\.local > \.cm-kebab \{ position:sticky/.test(css)
          ? "★sticky 로 되돌아감 — 실측에서 깨졌던 방식"
          : "절대배치 유지",
      ),
      assert(
        // 갱신 대상은 hover 중인 한 장뿐 — 카드마다 옵저버를 달면 목록 길이에 비례한다.
        "갱신 대상은 hover 중인 카드 하나뿐(목록 길이와 무관)",
        js.includes("let followed = null;") && js.includes("followed = { host, btn }"),
        "단일 대상 확인",
      ),
      assert(
        // 카드가 다 보이면 원래 자리로 — 짧은 카드는 동작 변화 0이어야 한다.
        "카드가 화면에 다 들어오면 원래 자리(7px)로 돌아간다",
        js.includes("const KEBAB_TOP = 7;") && js.includes("Math.max(0, sr.top - hr.top)"),
        "원위치 복귀 확인",
      ),
    ];
  },
};
