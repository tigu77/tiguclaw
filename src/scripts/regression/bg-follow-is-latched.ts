/**
 * 회귀: **잡 카드 팔로우가 래치다** — 매 삽입마다 기하로 다시 유도하지 않는다
 * (2026-09-10 적대 검토 P-1·P-2).
 *
 * 사고 전 상태: 정렬을 «오래된 것 위, 최신 아래» 로 뒤집으면서 팔로우 판정을
 * «지금 바닥 근처인가» 로 바꿨다. 그런데 스냅이 도는 시점에 카드는 아직
 * `display:none`(`.bg-in-scope` 미부착)이라 **높이가 0**이고, `scrollTop = scrollHeight`
 * 가 **직전 바닥**에 착지한다. 카드가 뒤늦게 자라면 그만큼 바닥과 벌어지고, 다음 삽입의
 * «바닥 근처인가» 가 거짓이 되어 **다시는 안 붙는다.**
 *
 * 실측(헤드리스, 드로어를 연 채 잡이 하나씩 도착 — 사용자는 스크롤을 안 만짐):
 *
 *     카드 2:  st=0   바닥까지=12
 *     카드 3:  st=12  바닥까지=151   ← 여기서 끊긴다
 *     카드 11: st=12  바닥까지=1340  ← 새 잡 8개가 화면 밖
 *
 * ★**측정 시점을 고치는 것으로는 안 닫힌다.** `.bg-in-scope` 뒤로 스냅을 미뤄도 카드는
 *  그 뒤로 **107px → 167px** 로 더 자란다(라벨·live 줄·doing 줄·요약·배지가 나중에
 *  채워진다). +60px 는 임계 40 을 넘는다 — 경계를 하나 고쳐도 다음 경계가 있다.
 *  뿌리는 «매 삽입마다 기하로 상태를 다시 유도한다» 이고, 처방은 **래치**다.
 *
 * ★★**이 검사의 첫 판은 가짜였다**(2026-09-10, 같은 날 변이로 적발). 단언 7건이었는데
 *  변이 5종 중 **4종을 통과**시켰다 — 원래 결함인 «래치를 기하 재유도로 되돌리기» 와
 *  «초기값 꺼짐» 이 둘 다 초록이었다. 이유가 둘이고 둘 다 흔한 함정이다:
 *   ① 동작 단언이 **제품이 아니라 검사 안에 다시 구현한 래치**를 쟀다 — 제품을 어떻게
 *     바꾸든 초록인 «항상 초록인 가짜 검사».
 *   ② 배선 단언이 «이름이 파일에 있나» 를 봤다 — 선언만 남기고 **쓰는 자리**를 바꾸면
 *     통과한다. (`/observe\(el\)/` 는 심지어 `unobserve(el)` 에 매칭됐다.)
 *  그래서 지금은 **소스에서 핀 트리오를 떼어 실제로 돌린다.** `job-label-prefix` 가
 *  드로어 조각을 vm 에서 돌리는 것과 같은 방식이다.
 *
 * ★«뒤늦게 자란다» 가 이 검사의 하중을 받는 부분이다 — append 직후 높이가 확정되는
 *  스텁이면 깨진 코드(기하 재유도)도 초록이다. 스텁 스크롤러는 **나중에** 자란다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { readSourceSync } from "./_wiring.js";

const START = "const BG_JUMP_THRESHOLD";
const END = "const bgUnobserveCard = (el) =>";

/** 뒤늦게 자라는 스텁 스크롤러 — 실제 카드가 0 → 107 → 167px 로 자라는 것을 흉내낸다. */
interface Scroller {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  addEventListener(type: string, fn: () => void, opts?: unknown): void;
  __fire(type: string): void;
  __gap(): number;
}

const makeScroller = (clientHeight: number): Scroller => {
  const handlers = new Map<string, Array<() => void>>();
  // ★`scrollTop` 은 **클램프된다** — 브라우저가 `scrollHeight - clientHeight` 를 넘겨
  //  쓰지 못하게 한다. 제품 코드가 `scrollTop = scrollHeight` 로 «바닥으로» 를 표현하는
  //  것이 성립하는 이유가 이것이라, 스텁이 클램프를 안 하면 검사가 **제품이 아니라 스텁의
  //  거짓말**을 잰다(첫 판이 그래서 -450px 로 빨개졌다).
  let top = 0;
  const sc = {
    clientHeight,
    scrollHeight: 0,
    get scrollTop(): number {
      return top;
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - this.clientHeight)));
    },
    addEventListener(type: string, fn: () => void) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
    __fire(type: string): void {
      for (const fn of handlers.get(type) ?? []) fn();
    },
    __gap(): number {
      return Math.max(0, this.scrollHeight - this.clientHeight) - top;
    },
  };
  return sc as Scroller;
};

/** 소스에서 핀 트리오를 떼어 **실제로** 돌린다(제품 코드를 재는 유일한 길). */
const loadPinTrio = (
  src: string,
  scroller: Scroller,
): {
  pin: () => void;
  observeCard: (el: unknown) => void;
  jumpHidden: () => boolean;
  clickJump: () => void;
  roCallbacks: Array<() => void>;
  observed: unknown[];
  unobserved: unknown[];
} => {
  const from = src.indexOf(START);
  const to = src.indexOf(END);
  if (from < 0 || to < 0) throw new Error("핀 트리오를 못 찾음(검사 전제가 깨졌다)");
  const slice = `${src.slice(from, to)}${END} { if (bgCardRO) bgCardRO.unobserve(el); };`;

  const observed: unknown[] = [];
  const unobserved: unknown[] = [];
  const roCallbacks: Array<() => void> = [];
  const bgJump = { hidden: false, addEventListener: (_t: string, fn: () => void) => void jumpHandlers.push(fn) };
  const jumpHandlers: Array<() => void> = [];
  class FakeRO {
    constructor(cb: () => void) {
      roCallbacks.push(cb);
    }
    observe(el: unknown): void {
      observed.push(el);
    }
    unobserve(el: unknown): void {
      unobserved.push(el);
    }
  }

  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "bgList",
    "bgJump",
    "ResizeObserver",
    `${slice}\nreturn { bgPin, bgObserveCard, bgUnobserveCard, updateBgJump };`,
  ) as (
    l: Scroller,
    j: unknown,
    r: unknown,
  ) => {
    bgPin: () => void;
    bgObserveCard: (el: unknown) => void;
    bgUnobserveCard: (el: unknown) => void;
    updateBgJump: () => void;
  };
  const api = factory(scroller, bgJump, FakeRO);
  return {
    pin: () => {
      api.bgPin();
      api.updateBgJump();
    },
    observeCard: api.bgObserveCard,
    jumpHidden: () => bgJump.hidden,
    clickJump: () => {
      for (const h of jumpHandlers) h();
    },
    roCallbacks,
    observed,
    unobserved,
  };
};

export const check: RegressionCheck = {
  name: "bg-follow-is-latched",
  guards:
    "백그라운드 잡 카드 팔로우가 첫 오버플로 이후 **영구히** 꺼지던 것 — 스냅이 " +
    "카드가 아직 안 보일 때(높이 0) 돌아 직전 바닥에 착지했고, 카드가 뒤늦게 자라며 " +
    "벌어진 간격이 다음 판정을 영영 거짓으로 만들었다",
  async run(): Promise<Assertion[]> {
    const out: Assertion[] = [];
    const src = readSourceSync("packages/dashboard/js/background-drawer.js");

    // ── ① 12장이 연속 도착하고 **각자 뒤늦게 자라도** 바닥을 따라간다 ──────────────
    {
      const sc = makeScroller(450);
      const t = loadPinTrio(src, sc);
      const cards: unknown[] = [];
      for (let i = 0; i < 12; i++) {
        const el = { id: i };
        cards.push(el);
        // 삽입 — 이때 카드는 아직 `.bg-in-scope` 전이라 **높이 0**이다.
        t.observeCard(el);
        t.pin();
        // 라벨이 채워지며 107px, 그 뒤 live/doing/요약이 채워지며 +60px.
        for (const grow of [107, 60]) {
          sc.scrollHeight += grow;
          for (const cb of t.roCallbacks) cb(); // ResizeObserver 발화
        }
      }
      out.push(
        assert(
          "★★12장이 연속 도착하고 **각자 뒤늦게 자라도** 마지막 카드가 바닥에 붙어 있다 — 이게 깨지면 새 잡이 화면 밖에서 진행되고 사용자는 뭐가 도는지 못 본다",
          sc.__gap() === 0,
          `바닥까지 ${sc.__gap()}px (scrollTop=${sc.scrollTop} / scrollHeight=${sc.scrollHeight})`,
        ),
        assert(
          "★★관찰은 **카드마다** 건다 — `#bg-list` 는 `flex:1` 이라 오버플로 뒤엔 자기 높이가 안 변해(실측 clientHeight 450 고정) 컨테이너 관찰자는 정확히 문제 구간에서 한 번도 안 운다",
          t.observed.length === 12 && t.observed[0] === cards[0],
          `관찰 ${t.observed.length}건 (카드 12장)`,
        ),
      );
    }

    // ── ② 사용자가 위로 올리면 따라가지 않는다(yank 금지) ─────────────────────────
    {
      const sc = makeScroller(450);
      const t = loadPinTrio(src, sc);
      for (let i = 0; i < 6; i++) {
        t.observeCard({ id: i });
        t.pin();
        sc.scrollHeight += 167;
        for (const cb of t.roCallbacks) cb();
      }
      sc.scrollTop = 0; // 사용자가 위로 끌었다
      sc.__fire("scroll"); // → 래치가 꺼져야 한다
      const parked = sc.scrollTop;
      t.observeCard({ id: 99 });
      t.pin();
      sc.scrollHeight += 167;
      for (const cb of t.roCallbacks) cb();
      out.push(
        assert(
          "★★사용자가 위로 올려 과거 잡을 보는 중이면 새 카드가 와도 **끌어내리지 않는다** — 읽던 자리를 뺏는 것은 팔로우가 아니라 방해다",
          sc.scrollTop === parked,
          `올려둔 위치 ${parked} → 삽입·성장 뒤 ${sc.scrollTop}`,
        ),
        assert(
          "★위를 보는 중이면 «↓ 최신» 버튼이 **보인다** — 노출과 팔로우가 같은 판정(래치)을 써야 임계가 안 갈린다",
          t.jumpHidden() === false,
          `버튼 hidden=${t.jumpHidden()}`,
        ),
      );

      // ③ 버튼을 누르면 다시 켜지고 바닥으로 간다.
      t.clickJump();
      out.push(
        assert(
          "★★«↓ 최신» 을 누르면 팔로우가 **다시 켜진다** — 이미 바닥이면 scroll 이벤트가 안 나므로 명시로 켜지 않으면 래치가 꺼진 채 남는다",
          sc.__gap() === 0 && t.jumpHidden() === true,
          `바닥까지 ${sc.__gap()}px · 버튼 hidden=${t.jumpHidden()}`,
        ),
      );
    }

    // ── ③ 새로고침 하이드레이션이 **바닥(최신)** 에 안착한다 (P-2) ────────────────
    {
      const sc = makeScroller(450);
      const t = loadPinTrio(src, sc);
      for (let i = 0; i < 40; i++) {
        t.observeCard({ id: i });
        t.pin();
        sc.scrollHeight += 146;
        for (const cb of t.roCallbacks) cb();
      }
      out.push(
        assert(
          "★★새로고침 뒤 드로어가 **최신**에 있다(래치 초기값이 켜짐) — 종전엔 40건을 그리고 꼭대기=가장 오래된 잡에 착지했다. 채팅은 열면 바닥인데 드로어만 반대면 뒤집기의 명분이던 «같은 시간축» 이 첫 화면에서 안 지켜진다",
          sc.__gap() === 0,
          `40건 하이드레이션 후 바닥까지 ${sc.__gap()}px`,
        ),
      );
    }

    // ── ④ 지운 카드는 관찰도 뗀다 — 호출 자리가 실제로 도는지 본다 ────────────────
    {
      const sc = makeScroller(450);
      const t = loadPinTrio(src, sc);
      const el = { id: "gone" };
      t.observeCard(el);
      // `capBgList` 가 `bgUnobserveCard(node)` 를 부르는지는 배선이라 소스로 본다 —
      // 다만 «정의가 있나» 가 아니라 **제거 자리에서 부르는가** 를 본다(정의만 남기고
      // 호출을 빼는 변이가 첫 판을 통과했다).
      const capFrom = src.indexOf("const capBgList");
      const capBlock = capFrom < 0 ? "" : src.slice(capFrom, capFrom + 1200);
      out.push(
        assert(
          "★상한 정리가 카드를 지울 때 **그 자리에서** 관찰을 뗀다 — 정의만 있고 안 부르면 관찰자가 카드마다 쌓여 무한히 는다",
          /bgUnobserveCard\([a-zA-Z]+\);\s*[a-zA-Z]+\.remove\(\)/.test(capBlock),
          capFrom < 0 ? "★capBgList 를 못 찾음" : `제거 자리에서 unobserve 호출=${/bgUnobserveCard\(/.test(capBlock)}`,
        ),
      );
    }

    return out;
  },
};
