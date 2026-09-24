/**
 * 회귀: **접힌 카드를 펼치면 «실제로 가리고 있는 카드» 가 펼쳐진다** (2026-09-24).
 *
 * ★사고(정태님 신고): *"채팅에서 간혹 방금 들어온 응답이 접혀진 상태로 펼침이 작동을 안 할 때가
 *  있어 — 눌러도 아무 반응이 없고"*. 헤드리스 재현: 턴 진행 중 도구 카드 머리줄을 눌러 접으면
 *  **그룹 전체**가 `.is-collapsed` 가 된다(설계 — 도구 카드를 접으면 답변도 같이 숨는다). 그 뒤
 *  답변이 **그 그룹 안에** 도착하면 3줄로 잘린 채 나오는데, 답변 머리줄을 누르면 **답변 자신**만
 *  토글돼 바깥 그룹이 계속 가렸다 — 높이 57px 그대로, 두 번 눌러도 그대로.
 *
 * 지키는 것:
 *  ① 조상 카드가 접혀 있으면 안쪽 머리줄의 대상은 **그 조상**이다.
 *  ② 조상이 안 접혀 있으면 종전대로 **자기 카드**다(넓힘 방지 — 아무 머리줄이나 바깥을 접으면 안 된다).
 *     답변 자신도 접혀 있어도 마찬가지다(중첩 접힘 — 자기 자신은 조상이 아니다).
 *  ③ 펼칠 머리줄이 없는 조상은 대상이 아니다(되돌릴 손잡이가 없으면 접지도 펴지도 않는다).
 *  ④ 클릭과 우클릭 메뉴가 **같은 판정**을 지난다(두 벌이면 한쪽만 고쳐진다).
 *
 * 등급: ①~③ 동작(파일에서 떼어낸 실제 함수를 가짜 DOM 위에서 실행) · ④ 소스 대조.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/dashboard/js");

/** 이 검사에 필요한 만큼만 흉내 낸 요소 — 클래스·부모·id·머리줄 유무. */
interface FakeEl {
  id?: string;
  classes: Set<string>;
  parentElement: FakeEl | null;
  hasHead: boolean;
  classList: { contains: (c: string) => boolean };
  closest: (sel: string) => FakeEl | null;
  querySelector: (sel: string) => unknown;
}
const el = (classes: string[], parent: FakeEl | null, opts: { id?: string; hasHead?: boolean } = {}): FakeEl => {
  const e: FakeEl = {
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    classes: new Set(classes),
    parentElement: parent,
    hasHead: opts.hasHead ?? true,
    classList: { contains: (c) => e.classes.has(c) },
    // 쓰는 셀렉터는 `#stream .is-collapsed` 하나 — 그것만 해석한다.
    closest: (sel) => {
      if (sel !== "#stream .is-collapsed") throw new Error(`fake closest: ${sel}`);
      for (let n: FakeEl | null = e; n !== null; n = n.parentElement) {
        if (!n.classes.has("is-collapsed")) continue;
        for (let a = n.parentElement; a !== null; a = a.parentElement) if (a.id === "stream") return n;
      }
      return null;
    },
    querySelector: () => (e.hasHead ? {} : null),
  };
  return e;
};

const pick = (src: string, name: string): string =>
  new RegExp(`const ${name} = \\([^)]*\\) =>[\\s\\S]*?;\\n`).exec(src)?.[0] ?? "";

export const check: RegressionCheck = {
  name: "collapse-expands-what-hides",
  guards:
    "도구 카드를 접은 그룹 안에 답변이 도착하면 3줄로 잘린 채 나오고, 답변 머리줄을 눌러도 답변 자신만 토글돼 바깥 그룹이 계속 가리던 것(눌러도 반응 없음)",
  run: async (): Promise<Assertion[]> => {
    const virt = readFileSync(path.join(DASH, "virtualization.js"), "utf8");
    const reply = readFileSync(path.join(DASH, "reply.js"), "utf8");
    const target = /const collapseTargetFor = \(root\) => \{[\s\S]*?\n {6}\};/.exec(virt)?.[0] ?? "";
    const head = pick(virt, "cardCollapseHead");
    const ctx = vm.createContext({});
    if (target !== "" && head !== "") vm.runInContext(`${head}\n${target}\nthis.collapseTargetFor = collapseTargetFor;`, ctx);
    const fn = (ctx as { collapseTargetFor?: (r: FakeEl) => FakeEl }).collapseTargetFor;

    const stream = el([], null, { id: "stream" });
    const collapsedGroup = el(["turn-group", "is-collapsed"], stream);
    const bubbleInCollapsed = el(["ev"], collapsedGroup);
    const openGroup = el(["turn-group"], stream);
    const bubbleInOpen = el(["ev"], openGroup);
    const headlessGroup = el(["turn-group", "is-collapsed"], stream, { hasHead: false });
    const bubbleInHeadless = el(["ev"], headlessGroup);
    // 중첩 접힘 — 답변을 먼저 접고 도구 카드로 그룹까지 접은 상태(싱크 레드팀 C F3).
    const nestedGroup = el(["turn-group", "is-collapsed"], stream);
    const collapsedBubble = el(["ev", "is-collapsed"], nestedGroup);

    const clickSite = /toggleCardCollapsed\(collapseTargetFor\(root\)\)/.test(virt.replace(/^\s*\/\/.*$/gm, ""));
    const menuAction = /toggleCardCollapsed\(collapseTargetFor\(ctx\.el\)\)/.test(reply.replace(/^\s*\/\/.*$/gm, ""));
    const menuLabel = /const root = ctx && ctx\.el \? collapseTargetFor\(ctx\.el\) : null;/.test(reply);

    return [
      assert("판정 함수를 떼어냈다(없으면 아래는 공짜 초록)", typeof fn === "function", `target ${target.length}자 · head ${head.length}자`),
      assert(
        "★★① 접힌 그룹 안의 답변 머리줄을 누르면 **그룹**이 펼쳐진다(답변 자신만 토글하면 계속 가려진다)",
        fn?.(bubbleInCollapsed) === collapsedGroup,
        fn?.(bubbleInCollapsed) === collapsedGroup ? "그룹" : "★답변 자신",
      ),
      assert(
        "② 그룹이 안 접혀 있으면 종전대로 답변 자신(아무 머리줄이나 바깥을 접지 않는다)",
        fn?.(bubbleInOpen) === bubbleInOpen,
        fn?.(bubbleInOpen) === bubbleInOpen ? "자기 카드" : "★바깥 그룹",
      ),
      assert(
        "③ 펼칠 머리줄이 없는 조상은 대상이 아니다",
        fn?.(bubbleInHeadless) === bubbleInHeadless,
        fn?.(bubbleInHeadless) === bubbleInHeadless ? "자기 카드" : "★손잡이 없는 조상",
      ),
      assert(
        "★① 답변도 접히고 그룹도 접혀 있으면 **그룹**부터(자기 자신을 조상으로 치면 답변만 펴지고 그룹이 계속 가린다)",
        fn?.(collapsedBubble) === nestedGroup,
        fn?.(collapsedBubble) === nestedGroup ? "그룹" : "★답변 자신",
      ),
      assert(
        "④ 머리줄 클릭·우클릭 메뉴(동작·라벨)가 같은 판정을 지난다",
        clickSite && menuAction && menuLabel,
        `클릭=${clickSite} 메뉴동작=${menuAction} 메뉴라벨=${menuLabel}`,
      ),
    ];
  },
};
