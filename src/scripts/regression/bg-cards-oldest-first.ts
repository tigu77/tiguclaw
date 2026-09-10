/**
 * 회귀: **백그라운드 카드는 «오래된 것부터 아래로»** — 그리고 그 방향이 **네 곳에서 같다**
 * (2026-09-10 정태님: *"백그라운드 카드 정렬도 오래된 시간순이 어떨까?"*).
 *
 * ★정렬 하나를 뒤집으면 **따라 뒤집혀야 하는 것이 셋 더** 있다. 하나라도 빠지면 조용하다:
 *
 *   ①삽입      `appendChild`         — 새 카드가 아래
 *   ②팔로우    바닥 근처였으면 스냅   — **삽입 전에** 재야 한다(뒤에 재면 늘 "바닥 아님")
 *   ③점프      «↓ 최신» · 바닥으로   — 반대로 두면 버튼이 과거로 데려간다
 *   ④상한정리  **앞에서부터** 지운다  — 안 고치면 «가장 최근에 끝난 잡부터» 지운다
 *
 * ★특히 ④가 위험하다 — 화면만 보면 모른다. 종전엔 뒤에서부터 지웠고 그때는 뒤가 오래된
 *  것이었다. 정렬만 뒤집으면 같은 코드가 정반대 일을 한다([[feedback_scope_of_a_fix]]
 *  «조건을 반전했나 → 도달하는 입력 전수»).
 *
 * ★소스를 읽는 검사인 이유: 카드를 실제로 만들려면 LLM 턴이 필요하다. 대신 **한 방향인가**
 *  라는 계약을 본다 — 이 변경의 진짜 위험은 동작이 아니라 **네 곳의 불일치**다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync, stripComments } from "./_wiring.js";

export const check: RegressionCheck = {
  name: "bg-cards-oldest-first",
  guards:
    "잡 카드 정렬을 뒤집으면서 팔로우·점프·상한정리 중 하나를 안 고쳐 방향이 갈리던 것 " +
    "(특히 상한정리는 반대로 두면 가장 최근에 끝난 잡부터 지운다 — 조용하다)",
  async run(): Promise<Assertion[]> {
    const src = stripComments(readSourceSync("packages/dashboard/js/background-drawer.js"));
    const out: Assertion[] = [];

    // ① 삽입 — 아래로 쌓는다
    out.push(
      assert(
        "★★새 카드를 **아래에** 붙인다 — 위에 넣으면 최신이 위가 되어 채팅과 시간축이 반대로 흐른다",
        /bgList\.appendChild\(el\)/.test(src) && !/bgList\.insertBefore\(el, bgList\.firstChild\)/.test(src),
        `appendChild=${/bgList\.appendChild\(el\)/.test(src)} · 옛 insertBefore=${/bgList\.insertBefore\(el, bgList\.firstChild\)/.test(src)}`,
      ),
    );

    // ② 팔로우 — 삽입 자리에서 **다시 유도하지 않는다**
    // ★2026-09-10 개정: 종전 단언은 «삽입 **전에** 재라» 였다. 그 처방은 맞았지만 부족했고,
    //  적대 검토 P-1 이 그 부족분을 실증했다 — 카드가 `.bg-in-scope` 전엔 높이 0이고 그
    //  뒤로도 107→167px 로 자라서, **언제 재든** 다음 판정이 어긋난다. 처방은 «재는 시점»
    //  이 아니라 **래치**이고, 늦은 성장은 카드별 ResizeObserver 가 흡수한다.
    //  옛 단언을 남겨두면 그것이 옳은 수정을 막는다(실제로 빨간불을 냈다).
    //  성질은 그대로다: **새 카드가 와도 팔로우가 영영 안 꺼진다.**
    //  동작은 `bg-follow-is-latched` 가 «뒤늦게 자라는 스크롤러» 로 잰다.
    const i = src.indexOf("bgList.appendChild(el)");
    const after = i < 0 ? "" : src.slice(i, i + 320);
    out.push(
      assert(
        "★★삽입 자리에서 «바닥 근처인가» 를 **다시 유도하지 않는다** — 카드는 삽입 시점에 높이 0이고 그 뒤로도 자라므로, 언제 재든 다음 판정이 어긋나 팔로우가 영구히 꺼진다",
        i >= 0 && !/bgNearBottom\(\)/.test(after),
        i < 0 ? "★삽입부를 못 찾음" : `삽입부 320자에 기하 재유도 있음=${/bgNearBottom\(\)/.test(after)}`,
      ),
      assert(
        "★삽입 후 **래치 핀**을 부른다 — 래치가 켜져 있을 때만 붙이므로 위를 보는 중이면 안 끌어내린다",
        /bgPin\(\);/.test(after),
        `핀 호출=${/bgPin\(\);/.test(after)}`,
      ),
    );

    // ③ 점프 — 판정이 **한 벌**이고 방향이 아래다
    out.push(
      assert(
        "★★점프 노출과 팔로우가 **같은 판정**(래치)을 쓴다 — 두 벌이면 임계가 갈려 버튼이 깜빡인다",
        /let bgStick = /.test(src) && /hidden = bgStick/.test(src),
        `래치 정의=${/let bgStick = /.test(src)} · 점프가 사용=${/hidden = bgStick/.test(src)}`,
      ),
      assert(
        "★점프가 **바닥**으로 간다 — 반대로 두면 «최신» 버튼이 과거로 데려간다",
        !/bgJump\.addEventListener\("click", \(\) => \{ bgList\.scrollTop = 0;/.test(src),
        `옛 «맨 위로» 잔존=${/bgList\.scrollTop = 0; updateBgJump/.test(src)}`,
      ),
    );

    // ④ 상한 정리 — 앞(=오래된 것)에서부터
    const cap = src.slice(src.indexOf("const capBgList"), src.indexOf("const capBgList") + 700);
    out.push(
      assert(
        "★★상한 정리가 **앞에서부터** 훑는다 — 정렬이 오래된 순이므로 앞이 가장 오래된 것이다. 뒤에서부터 두면 «가장 최근에 끝난 잡» 을 지우고, 화면만 보면 모른다",
        /for \(let i = 0; i < cards\.length; i\+\+\)/.test(cap),
        cap === "" ? "★capBgList 를 못 찾음" : `앞에서부터=${/for \(let i = 0; i < cards\.length; i\+\+\)/.test(cap)} · 옛 역순=${/for \(let i = cards\.length - 1/.test(cap)}`,
      ),
    );

    // ⑤ 문구도 같은 방향 — 화면 글자가 반대면 그게 곧 거짓 안내다
    const ko = JSON.parse(readSourceSync("locales/ko.json")) as Record<string, string>;
    const en = JSON.parse(readSourceSync("locales/en.json")) as Record<string, string>;
    out.push(
      assert(
        "★버튼 문구가 **아래** 방향이다(양 언어) — 코드는 바닥으로 가는데 글자가 «맨 위로» 면 그게 거짓 안내다",
        (ko["bg.jump.text"] ?? "").includes("↓") &&
          (en["bg.jump.text"] ?? "").includes("↓") &&
          !(ko["bg.jump.title"] ?? "").includes("맨 위로"),
        `ko=${JSON.stringify(ko["bg.jump.text"])}/${JSON.stringify(ko["bg.jump.title"])} · en=${JSON.stringify(en["bg.jump.text"])}`,
      ),
    );

    // ★**매니저 아이콘은 이제 코드에 안 박힌다** (2026-09-10 정태님: *"코드에 박힌 걸 빼면
    //  되지 않을까"*). 이모지가 이미 로케일에 47개 있어 `<home>/locales/<lang>.json` 으로
    //  덮을 수 있는데 잡 아이콘만 코드에 박혀 **그것만 못 바꾸는** 상태였다.
    // ★검사 대상이 «세 파일의 리터럴이 같은가» → «리터럴이 **없는가** + 카탈로그가 한 벌인가»
    //  로 옮겨간다. 리터럴을 세는 검사를 남겨두면 그게 오히려 되돌리기를 부른다.
    // ★폴백 리터럴은 **허용한다** — 옛 배포본·반쯤 번역된 파일에서 글자가 키 이름
    //  («job.kind.worker.icon»)이 되면 안 된다. 그래서 «조회 없이 박혔나» 만 본다.
    const core = ["src/index.ts", "packages/dashboard/js/background-drawer.js"];
    // ★**주석에 걸리지 않게 코드만 본다** (2026-09-10 적대 검토 G-1: 730줄 «주석» 의 키 이름이
    //  게이트를 통과시켰다 — 검사 대상은 마크업이지 그걸 설명하는 글이 아니다).
    // ★그리고 조회 수단이 공용 `kindIcon`(util.js)으로 올라갔다 — 이름을 하나 박지 말고
    //  «카탈로그를 보는 호출» 을 넓게 센다.
    const lookedUp = core.filter((f) =>
      /job\.kind\.\w+\.icon|kindIcon\(|translate\(iconKey\)/.test(stripComments(readSourceSync(f))),
    );
    out.push(
      assert(
        "★★잡 아이콘을 **카탈로그에서 읽는다**(서버·드로어) — 코드에 박아 두면 사용자가 그것만 못 바꾼다",
        lookedUp.length === core.length,
        `조회하는 파일 ${lookedUp.length}/${core.length}: ${lookedUp.map((f) => f.split("/").pop()).join(", ")}`,
      ),
    );
    const widget = readSourceSync("plugins/running-work/web/widget.js");
    out.push(
      assert(
        "★위젯은 **자기 카탈로그**를 쓴다(`ctx.t`) — 플러그인이 코어 키를 읽는 건 결함이 아니라 격리 위반이다",
        /ctx\.t\("icon\." \+ kind\)/.test(widget),
        `자기 카탈로그 조회=${/ctx\.t\("icon\./.test(widget)}`,
      ),
    );
    const pk = JSON.parse(readSourceSync("plugins/running-work/web/locales/ko.json")) as Record<string, string>;
    const icons = new Set([
      ko["job.kind.worker.icon"] ?? "",
      en["job.kind.worker.icon"] ?? "",
      pk["icon.worker"] ?? "",
    ]);
    out.push(
      assert(
        "★★`agents.kind.*` 에 이모지를 **다시 품지 않는다** — 품으면 아이콘 키를 덮어도 배지만 옛 이모지로 남아 같은 화면에서 갈린다(적대 검토 B-P1)",
        !/[\u{1F300}-\u{1FAFF}]/u.test(String(ko["agents.kind.worker"] ?? "")) &&
          !/[\u{1F300}-\u{1FAFF}]/u.test(String(ko["agents.kind.agent"] ?? "")),
        `ko.worker=${JSON.stringify(ko["agents.kind.worker"])} · ko.agent=${JSON.stringify(ko["agents.kind.agent"])}`,
      ),
    );
    out.push(
      assert(
        "★★값이 **한 벌**이다(코어 ko·en + 1차 번들 위젯) — 이 위젯은 코어 데이터를 그리므로 아이콘이 갈리면 같은 잡이 화면마다 달라 보인다",
        icons.size === 1 && !icons.has(""),
        `ko=${ko["job.kind.worker.icon"]} · en=${en["job.kind.worker.icon"]} · widget=${pk["icon.worker"]}`,
      ),
    );

    return out;
  },
};
