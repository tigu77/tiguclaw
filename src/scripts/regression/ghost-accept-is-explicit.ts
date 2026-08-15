/**
 * 회귀: 제안 수락은 **명시적 행동**이다 — 입력창을 탭했다고 들어오지 않는다 (2026-08-15).
 *
 * 사용자 요청: *"모바일에서는 제안 메시지가 바로 적용되잖아. 클로드앱에선 제안 메시지 바로
 * 옆에 화살표 버튼이 있더라고 — 그렇게 적용 버튼이 따로 있으니까 깔끔하던데."*
 *
 * 종전 동작: 모바일에서 **입력창이 포커스되는 순간** 제안이 수락됐다. 그냥 타이핑하려고
 * 눌렀는데 제안이 들어와 지우고 시작해야 했다.
 *
 * ★그렇게 된 데는 이유가 있었다 — 2026-08-10 에 고스트 자체를 탭 가능하게 만들었더니 첫
 *  터치가 textarea 가 아니라 고스트에 맞았고, 포커스가 *프로그램적* 으로 옮겨져 iOS 가
 *  입력창을 키보드 위로 안 올려줬다. 그래서 터치를 흘려보내고 포커스로 수락하게 물러섰다.
 *  **버튼이 그 딜레마를 푼다**: 입력창 터치는 브라우저 기본 그대로(키보드 문제 재발 없음),
 *  수락은 명시적 행동 하나. 우연히 발동하는 경로가 사라진다.
 *
 * ★수락은 **채우기까지**다. `Enter` 는 절대 수락이 아니다(Enter=전송이라 겹치면 오발신이고
 *  그건 되돌릴 수 없다) — 버튼도 같은 규칙을 따라 `type="button"` 이다. 폼 안이라 기본
 *  submit 이면 그 자체가 전송 버튼이 된다.
 *
 * 실동작은 헤드리스 Chrome+CDP 로 확인했다(제안 도착 → 버튼 표시 → 클릭 → 입력창에 채워짐
 * → 버튼 숨김). 여기서는 그 배선이 **살아 있는지**를 지킨다.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DASH = path.join(REPO, "packages/dashboard");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const html = await readFile(path.join(DASH, "index.html"), "utf8");
  const js = await readFile(path.join(DASH, "js/ghost-suggest.js"), "utf8");
  const css = await readFile(path.join(DASH, "app.css"), "utf8");

  // ── ① 버튼이 존재하고 **전송 버튼이 아니다** ────────────────────────────────
  const btn = /<button id="chat-ghost-accept"[^>]*>/.exec(html)?.[0] ?? "";
  out.push(
    assert(
      "제안 수락 버튼이 입력창 옆에 있다",
      btn !== "" && html.includes('id="chat-ghost-accept"'),
      btn === "" ? "★버튼 없음" : "버튼 확인",
    ),
  );
  out.push(
    assert(
      '★type="button" 이다(폼 안이라 기본 submit 이면 전송 버튼이 된다)',
      /type="button"/.test(btn),
      btn.slice(0, 80),
    ),
  );
  out.push(
    assert(
      "스크린리더용 이름이 있다(→ 하나만으론 뜻을 모른다)",
      /aria-label="[^"]+"/.test(btn),
      /aria-label="([^"]+)"/.exec(btn)?.[1] ?? "★없음",
    ),
  );

  // ── ② ★자동 수락이 사라졌다 — 이번 변경의 본질 ──────────────────────────────
  out.push(
    assert(
      "★입력창 포커스로 수락하지 않는다(그냥 쓰려고 탭한 사람에게 안 들어간다)",
      !/acceptOnTouchFocus/.test(js),
      /acceptOnTouchFocus/.test(js) ? "★포커스 자동수락이 남아 있다" : "자동수락 0",
    ),
  );

  // ── ③ 클릭이 **같은 입구**(accept)를 쓴다 — 판단이 두 곳에 생기지 않게 ──────
  out.push(
    assert(
      "버튼 클릭이 Tab 과 같은 accept() 를 부른다",
      /acceptBtn\.addEventListener\("click"[\s\S]{0,200}?accept\(\)/.test(js),
      "동일 입구 확인",
    ),
  );

  // ── ④ 고스트와 함께 뜨고 함께 사라진다 ──────────────────────────────────────
  out.push(
    assert(
      "고스트가 숨으면 버튼도 숨는다",
      /ghostEl\.hidden = true;[\s\S]{0,160}?acceptBtn\.hidden = true;/.test(js),
      "동반 숨김 확인",
    ),
  );
  out.push(
    assert(
      "고스트가 뜨면 버튼도 뜬다",
      /ghostEl\.hidden = false;[\s\S]{0,160}?acceptBtn\.hidden = false;/.test(js),
      "동반 표시 확인",
    ),
  );

  // ── ⑤ ★버튼만 누를 수 있다 — 고스트는 여전히 클릭을 안 가로챈다 ─────────────
  //  이게 2026-08-10 사고(iOS 키보드가 입력창을 덮음)의 재발 방지선이다.
  out.push(
    assert(
      "★고스트는 여전히 pointer-events:none(첫 터치를 안 뺏는다)",
      /#chat-ghost \{[\s\S]{0,400}?pointer-events:none/.test(css),
      "고스트 클릭 통과 확인",
    ),
  );
  out.push(
    assert(
      "버튼은 숨김 상태에서 자리를 차지하지 않는다",
      /#chat-ghost-accept\[hidden\] \{ display:none; \}/.test(css),
      "hidden 스타일 확인",
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "ghost-accept-is-explicit",
  guards:
    "모바일에서 입력창을 탭하는 것만으로 제안이 수락되던 것 — 그냥 쓰려던 사람이 지우고 시작해야 했다. 수락 버튼(채우기 전용)으로 대체했고, 고스트가 첫 터치를 안 뺏는 성질은 그대로 지킨다",
  run,
};
