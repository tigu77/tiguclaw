/**
 * 회귀: **플러그인 위젯이 채팅에 그려지고, 떼어질 때 회수된다** (2026-08-28, 위젯 플랫폼 증분 1).
 *
 * ★설계: `docs/decisions/2026-08-28-widget-platform.md`. 위젯은 **비서 답변에 딸린 첨부**다.
 *  그 자리를 고른 건 저장·복원·가상화·프루닝·검색이 **메시지 것을 타서 공짜로 오기** 때문이고,
 *  실제로 `buildAttachmentsPreview` 한 함수를 **라이브(`channel-hints.js`)와 복원
 *  (`history-render.js`)이 공유**한다 — 그래서 한 곳만 고치면 양쪽이 같이 간다.
 *
 * 지키는 것 넷:
 *  ① **등록 문이 닫혀 있다** — 아무 모양이나 등록되면 조용한 덮어쓰기가 생긴다.
 *  ② **떼어질 때 회수한다** — 채팅은 노드를 분리(가상화)·폐기(프루닝)한다. 타이머를 든
 *     위젯이 남으면 **상시 띄워두는** 제품에서 곧 누수다.
 *  ③ **한 위젯이 던져도 채팅이 안 죽는다** — mermaid 폴백과 같은 규칙.
 *  ④ ★**두 손 목록이 안 갈린다** — `_manifest.json`(서빙 화이트리스트)과 `index.html`
 *     (실제 `<script>`)이 **둘 다** 있어야 실린다.
 *
 * ★④는 오늘 **실제로 밟았다.** 매니페스트에만 넣고 `index.html` 을 안 고쳐서, 파일이
 *  **200 으로 서빙되는데 로드는 안 됐다**(헤드리스에서 `widgetHost is not defined`).
 *  기존 게이트(`dashboard-static-serving`)는 *"index.html 이 참조하는 게 서빙되나"* 한
 *  방향만 본다 — 반대쪽이 비어 있었다.
 *
 * 등급: **혼합** — 등록 판정은 `vm` 에서 실제로 부르고, 목록 대조도 실행이다. 배선(첨부
 * 분기가 위젯을 먼저 가로채나·회수를 코어가 하나)만 소스 대조이고 그 사실을 여기 적는다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DASH = path.join(REPO, "packages/dashboard");

export const check: RegressionCheck = {
  name: "widget-host-mounts-and-cleans",
  guards:
    "플러그인이 채팅에 위젯을 그릴 길이 없던 것 + 그 길을 열면서 생기는 셋: 조용한 덮어쓰기(같은 id 재등록)·떼어진 위젯의 타이머 누수·위젯 하나가 채팅을 죽이는 것. 그리고 js 모듈이 매니페스트에만 있고 index.html 에 없어 서빙은 되는데 로드가 안 되던 것",
  run: async (): Promise<Assertion[]> => {
    const host = readFileSync(path.join(DASH, "js/widget-host.js"), "utf8");
    const hist = readFileSync(path.join(DASH, "js/history-render.js"), "utf8");
    const html = readFileSync(path.join(DASH, "index.html"), "utf8");
    const css = readFileSync(path.join(DASH, "app.css"), "utf8");
    const manifest = JSON.parse(readFileSync(path.join(DASH, "js/_manifest.json"), "utf8")) as string[];
    const ko = JSON.parse(readFileSync(path.join(REPO, "locales/ko.json"), "utf8")) as Record<string, string>;
    const en = JSON.parse(readFileSync(path.join(REPO, "locales/en.json"), "utf8")) as Record<string, string>;

    let observerCb: ((records: unknown[]) => void) | null = null;

    // ── ① 등록 문 — `vm` 에서 **실제로 부른다** ──
    const ctx: Record<string, unknown> = {
      window: {} as Record<string, unknown>,
      document: {
        getElementById: () => null,
        createElement: () => ({ appendChild: () => {}, classList: { add: () => {} } }),
        head: { appendChild: () => {} },
        body: {},
      },
      // ★관측자 콜백을 **붙잡는다** — 가상화의 분리·재부착을 손으로 재현하려면 그 콜백을
      //  불러야 한다. 스텁으로 두면 이 파일이 지키려는 수명(§F)을 검사할 수가 없다.
      MutationObserver: class {
        constructor(cb: (records: unknown[]) => void) {
          observerCb = cb;
        }
        observe(): void {}
        disconnect(): void {
          observerCb = null;
        }
      },
      setTimeout: (fn: () => void) => fn(),
      i18n: (k: string) => k,
      HTMLElement: class {},
    };
    vm.createContext(ctx);
    vm.runInContext(`${host}\nthis.__host = widgetHost;`, ctx);
    const wh = ctx.__host as {
      register: (id: unknown, b: unknown) => boolean;
      mount: (el: unknown, att: unknown) => Promise<boolean>;
      state: () => {
        builders: string[];
        live: number;
        pending: number;
        observing: boolean;
      };
    };

    const good = { mount: (): void => {} };
    const REG: Array<[string, unknown, unknown, boolean]> = [
      ["정상", "weather/forecast", good, true],
      ["같은 id 재등록 — 거부", "weather/forecast", good, false],
      ["이름공간 없음", "forecast", good, false],
      ["빈 이름공간", "/forecast", good, false],
      ["문자열 아님", 42, good, false],
      ["mount 없음", "map/places", { unmount: (): void => {} }, false],
      ["빌더 없음", "map/places", null, false],
      ["다른 플러그인 — 통과", "map/places", good, true],
    ];
    const regWrong = REG.filter(([, id, b, want]) => wh.register(id, b) !== want);

    // ★**idle 상태를 먼저 붙잡는다** — 아래 ⑤가 실제로 마운트를 부르므로, 그 뒤에 재면
    //  "위젯이 없으면 관측자가 안 돈다" 가 자기 검사 때문에 빨개진다(실제로 그랬다).
    const idle = wh.state();

    // ── ⑤ 대기줄에 **고이지 않는다** — 실제로 부른다 (2026-08-28, 홈 위젯 실측) ──
    //  부모 없는 노드는 삽입될 일이 없다. 그걸 대기줄에 넣으면 `stopIfIdle` 이 영원히 안
    //  걸려 **관측자가 계속 돈다** — 화면은 멀쩡한 채로 이 파일의 약속("위젯 없으면 비용 0")
    //  만 조용히 깨진다.
    await wh.mount({ isConnected: false, parentNode: null }, { widget: "weather/forecast", data: {} });
    const orphanPending = wh.state().pending;
    await wh.mount(
      { isConnected: false, parentNode: {} },
      { widget: "weather/forecast", data: {} },
    );
    const legitPending = wh.state().pending;

    // ── ⑥ **수명** — 분리·재부착을 손으로 재현한다 (2026-08-28, 지도 위젯이 잡았다) ──
    //  설계 §F 는 *"mount 는 여러 번 불릴 수 있다(스크롤로 돌아옴). 멱등이어야 한다"* 고
    //  적어뒀는데 **그 계약이 구현돼 있지 않았다** — 회수만 하고 대기줄에 안 돌려놔서,
    //  가상화가 접었다 편 위젯은 영영 빈 칸이 됐다(실측: 왕복 뒤 행 높이 383→92).
    //  증분 1 검증이 "새로고침 복원"(한 번도 안 붙은 노드)만 봐서 통째로 사각지대였다.
    const fakeEl = (): Record<string, unknown> => {
      const El = ctx.HTMLElement as new () => Record<string, unknown>;
      const el = new El();
      el.isConnected = true;
      el.parentNode = {};
      el.classList = { add: (): void => {} };
      el.querySelectorAll = (): unknown[] => [];
      el.textContent = "";
      return el;
    };
    const fire = (removed: unknown[]): void => {
      observerCb?.([{ removedNodes: removed }]);
    };

    let mounted = 0;
    let unmounted = 0;
    wh.register("probe/ok", {
      mount: (): void => {
        mounted += 1;
      },
      unmount: (): void => {
        unmounted += 1;
      },
    });
    const el = fakeEl();
    // ★**증감으로 잰다** — 앞선 ⑤ 검사가 남긴 대기분이 있어 절대값은 이 검사의 것이 아니다.
    const pendingBase = wh.state().pending;
    await wh.mount(el, { widget: "probe/ok", data: {} });
    const afterMount = { mounted, live: wh.state().live };

    // 가상화가 창 밖으로 내보낸다 — 노드는 분리되고 관측자가 그걸 본다.
    el.isConnected = false;
    fire([el]);
    const afterDetach = { unmounted, live: wh.state().live, pending: wh.state().pending };

    // 다시 창 안으로 — **여기서 다시 그려져야 한다**.
    el.isConnected = true;
    fire([]);
    const afterReattach = { mounted, live: wh.state().live, pending: wh.state().pending };

    // 던지는 위젯 — 되돌리면 **무한 재시도**가 된다(실패 폴백이 스스로 DOM 을 바꾼다).
    wh.register("probe/boom", {
      mount: (): void => {
        throw new Error("의도된 폭발");
      },
      unmount: (): void => {},
    });
    const boom = fakeEl();
    const pendingBeforeBoom = wh.state().pending;
    const boomOk = await wh.mount(boom, { widget: "probe/boom", data: {} });
    const afterBoom = { boomOk, live: wh.state().live, pending: wh.state().pending };

    // ── ④ 두 목록 대조 — **양방향**, 목록을 손으로 안 든다 ──
    const tags = [...html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)].map((m) => m[1] as string);
    const inManifestOnly = manifest.filter((f) => !tags.includes(f));
    const inHtmlOnly = tags.filter((f) => !manifest.includes(f));

    return [
      assert(
        "★★등록 문이 진리표대로다(**실행해서** 확인 — 조용한 덮어쓰기 금지)",
        regWrong.length === 0,
        regWrong.length === 0
          ? `${REG.length}케이스 통과 · 등록됨 ${wh.state().builders.join(",")}`
          : `★틀림: ${regWrong.map(([n]) => n).join(" / ")}`,
      ),
      assert(
        "★★떼어졌다 **다시 붙으면 다시 그린다**(§F: mount 는 여러 번 불릴 수 있다) — 회수만 하고 안 돌려놓으면 가상화가 접은 위젯이 영영 빈 칸이 된다",
        afterMount.mounted === 1 &&
          afterDetach.unmounted === 1 &&
          afterDetach.live === 0 &&
          afterDetach.pending === pendingBase + 1 &&
          afterReattach.mounted === 2 &&
          afterReattach.live === 1,
        `마운트 ${afterMount.mounted}→${afterReattach.mounted} · 분리시 live=${afterDetach.live} 대기증가=${afterDetach.pending - pendingBase} · 재부착 live=${afterReattach.live}`,
      ),
      assert(
        "★★**던진 것은 대기줄로 안 돌아간다** — 되돌리면 실패 폴백이 스스로 DOM 을 바꿔 자기를 다시 깨우고, 그게 무한 재시도가 된다(고치자마자 실제로 페이지가 멈췄다)",
        afterBoom.boomOk === false &&
          afterBoom.live === afterReattach.live &&
          afterBoom.pending === pendingBeforeBoom,
        `mount=${afterBoom.boomOk} · pending ${pendingBeforeBoom}→${afterBoom.pending}`,
      ),
      assert(
        "★★부모 없는 노드는 대기줄에 **안 고인다**(고이면 관측자가 영영 안 꺼져 '위젯 없으면 비용 0' 이 거짓이 된다) — 부모가 있는 대기분은 그대로 기다린다",
        orphanPending === 0 && legitPending === 1,
        `고아=${orphanPending} · 정당한 대기=${legitPending}`,
      ),
      assert(
        "★위젯이 없으면 관측자가 **안 돈다**(채팅은 메시지마다 DOM 이 바뀌는 자리다 — 상시 관측 금지)",
        idle.observing === false && idle.live === 0 && idle.pending === 0,
        JSON.stringify(idle),
      ),
      // ── ④ ──
      assert(
        "★★`_manifest.json` 과 `index.html` 이 **정확히 같다**(한쪽만 있으면 서빙은 되는데 로드가 안 된다 — 오늘 실제로 밟았다)",
        inManifestOnly.length === 0 && inHtmlOnly.length === 0,
        inManifestOnly.length === 0 && inHtmlOnly.length === 0
          ? `${manifest.length}개 일치`
          : `★매니페스트만: [${inManifestOnly.join(",")}] · html 만: [${inHtmlOnly.join(",")}]`,
      ),
      assert(
        "★`widget-host.js` 가 `history-render.js` **보다 먼저** 실린다(첨부 분기가 그걸 부른다)",
        manifest.indexOf("widget-host.js") >= 0 &&
          manifest.indexOf("widget-host.js") < manifest.indexOf("history-render.js"),
        `widget-host=${manifest.indexOf("widget-host.js")} · history-render=${manifest.indexOf("history-render.js")}`,
      ),
      // ── ② 회수 ──
      assert(
        "★★떼어질 때 **코어가** 회수한다(플러그인의 성실함에 안 맡긴다 — 상시 띄워두는 제품에서 누수는 곧 체감이다)",
        /new MutationObserver/.test(host) &&
          /removedNodes/.test(host) &&
          /observer\.disconnect\(\)/.test(host),
        `관측=${/new MutationObserver/.test(host)} · 제거감지=${/removedNodes/.test(host)} · 자동종료=${/observer\.disconnect\(\)/.test(host)}`,
      ),
      assert(
        "★`onDispose` 와 `unmount` 를 **둘 다** 부른다(위젯이 어디에 맡겼든 회수된다)",
        /for \(const fn of entry\.dispose\)/.test(host) && /b\.unmount\(el\)/.test(host),
        `dispose=${/entry\.dispose/.test(host)} · unmount=${/b\.unmount\(el\)/.test(host)}`,
      ),
      // ★두 번 데인 자리다. ①빌드 시점엔 컨테이너가 아직 문서 밖이다(호출부가 나중에 넣는다)
      //  ②새로고침 복원은 **가상화가 창에 들어올 때** 넣으므로 잠깐 기다려도 안 붙는다.
      //  그래서 계약은 "기다린다" 가 아니라 **"들어오면 마운트한다"** 다.
      assert(
        "★★안 붙었으면 **대기시켰다가 들어올 때** 마운트한다(빌드 시점에 포기하면 스크롤해도 영영 안 뜬다)",
        host.includes("pending.set(el, att);") &&
          host.includes("const flushPending = () => {") &&
          host.includes("if (pending.size > 0) flushPending();"),
        `대기 등록=${host.includes("pending.set(el, att);")} · 삽입 시 처리=${host.includes("if (pending.size > 0) flushPending();")}`,
      ),
      assert(
        "★대기분이 남아 있으면 관측자를 **안 끈다**(끄면 들어와도 아무도 안 본다)",
        host.includes("if (pending.size === 0 && live.size === 0 && observer !== null)"),
        host.includes("pending.size === 0 && live.size === 0") ? "둘 다 볼 때만 끈다" : "★live 만 보고 끈다",
      ),
      assert(
        "★관측 범위가 특정 id 에 묶여 있지 않다(DOM 이 한 번 더 움직여도 조용히 안 깨지게)",
        host.includes("const host = document.body;") && !host.includes('getElementById("chat")'),
        host.includes("document.body") ? "문서 전체(위젯 있을 때만)" : "★id 결합",
      ),
      // ── ③ 격리 ──
      assert(
        "★위젯이 던져도 **채팅이 안 죽는다**(자리에 안내만 남는다)",
        /catch \{[\s\S]{0,300}?widget-failed/.test(host) && /i18n\("widget\.failed"\)/.test(host),
        `폴백=${/widget-failed/.test(host)}`,
      ),
      // ── 배선(소스 대조) ──
      assert(
        "★첨부 분기가 위젯을 **먼저** 가로챈다(파일 미리보기 경로로 새면 위젯이 첨부 카드로 그려진다)",
        /if \(a\.kind === "widget"\) \{[\s\S]{0,400}?widgetHost\.mount\(box, a\);[\s\S]{0,40}?return;/.test(hist) &&
          hist.indexOf('a.kind === "widget"') < hist.indexOf("const mime = a.mime"),
        `분기=${/a\.kind === "widget"/.test(hist)} · mime 처리보다 앞=${hist.indexOf('a.kind === "widget"') < hist.indexOf("const mime = a.mime")}`,
      ),
      assert(
        "★위젯 자리가 **토큰만** 쓴다(사용자 테마가 저절로 먹는다 — 색을 박으면 안 먹는다)",
        /\.chat-widget \{[^}]*\}/.test(css) &&
          !/\.chat-widget \{[^}]*#[0-9a-fA-F]{3,6}/.test(css) &&
          !/\.chat-widget \{[^}]*rgb\(/.test(css),
        (css.match(/\.chat-widget \{[^}]*\}/) ?? ["(없음)"])[0].slice(0, 90),
      ),
      assert(
        "★플러그인이 쓸 **문이 하나** 열려 있다(번들은 우리 모듈 스코프 밖에서 로드된다)",
        /window\.tiguWidgets = \{ register: widgetHost\.register \}/.test(host),
        /window\.tiguWidgets/.test(host) ? "열림" : "★닫힘 — 플러그인이 닿을 자리가 없다",
      ),
      assert(
        "★실패 문구가 **두 언어 모두** 있다",
        typeof ko["widget.failed"] === "string" && typeof en["widget.failed"] === "string",
        `ko=${typeof ko["widget.failed"]} · en=${typeof en["widget.failed"]}`,
      ),
    ];
  },
};
