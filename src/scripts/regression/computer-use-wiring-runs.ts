/**
 * 회귀: **`do` 의 실행 배선을 실제로 돌린다** — 입력 0 (2026-09-19).
 *
 * ★★**이 파일이 메우는 공백이 이 면적의 1순위였다.** 적대 검토(레드팀)와 외부 검토
 *  (회사돌쇠 아스트라)가 **각각 독립적으로** 같은 것을 짚었다: 판단(`control.ts`)은
 *  촘촘히 재는데 **그 판단을 «어떤 순서로 엮는가»(`index.ts`)는 한 줄도 안 잰다.**
 *  레드팀은 순서 변이 넷을 통과시켰고, 그중 하나(`endAction` 을 사후 장면 뒤로)는
 *  **첫 `do` 이후 도구가 영구 불능**이 되는데도 스위트가 초록이었다.
 *
 * ★**진짜 화면도 진짜 키보드도 안 쓴다.** `Wiring` 이음매에 **기록만 하는 실행부**를
 *  끼운다 — `post` 가 무엇을 몇 번 받았는지, `capture` 가 **어느 화면**을 받았는지를 센다.
 *  그래서 이 검사는 사용자 화면을 건드리지 않는다(principle-check Q7).
 *
 * ★**제품이 만드는 그 도구를 부른다** — `createTools` 는 플러그인 본체가 쓰는 바로 그
 *  함수다. 검사용 사본을 만들면 이 부류를 못 잡는다(§15-15).
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

type Rec = Record<string, unknown>;
interface ToolLike {
  name: string;
  handler: (args: Rec, extra: Rec) => Promise<{ content: Array<Rec> }>;
}
interface IndexModule {
  createTools: (w: Rec, host?: Rec) => ToolLike[];
  realWiring: () => { desktop: Rec; platform: string };
}
interface ControlModule {
  newDesktop: () => Rec;
}

/** 실행부 대역 — **아무것도 쏘지 않고** 무엇을 받았는지만 적는다. */
interface Log {
  /** ★`heldAtPost` = **쏘는 순간** 부모 장부에 무엇이 올라 있었나. 자식이 죽으면 되돌릴
   *  근거가 그것뿐이라, 「그때 무엇이 담겨 있었나」가 계약이다(쏜 뒤가 아니다). */
  posts: { events: Rec[]; heldAtPost: { keys: string[]; buttons: string[] } }[];
  captures: { target: Rec }[];
  order: string[];
}

const makeStubs = (
  log: Log,
  desktop: Rec,
  opts: {
    postOk?: boolean;
    postThrows?: boolean;
    releaseOk?: boolean;
    /** 조작 권한 프리플라이트를 **실패**시킨다 — 그 분기가 실제로 도는지 보려고. */
    preflightFail?: { reason: string; detail: string };
  } = {},
): { observe: Rec; control: Rec } => ({
  observe: {
    preflight: () =>
      Promise.resolve({
        ok: true,
        screens: [
          { x: 0, y: 0, w: 1920, h: 1080, scale: 1 },
          { x: 1920, y: 0, w: 1920, h: 1080, scale: 1 },
        ],
      }),
    capture: async (target: Rec, outPath: string) => {
      log.captures.push({ target });
      log.order.push("capture");
      // 실제 파일을 만든다 — 배관이 `stat`·`readFile` 을 지나야 «사후 장면» 이 성립한다.
      await fs.writeFile(outPath, "stub-frame");
      return { ok: true, bytes: 10, longEdge: 1600, path: outPath, deliveredPx: { w: 1600, h: 900 } };
    },
  },
  control: {
    controlPreflight: () =>
      Promise.resolve(
        opts.preflightFail === undefined
          ? { ok: true }
          : { ok: false, reason: opts.preflightFail.reason, detail: opts.preflightFail.detail },
      ),
    idleSeconds: () => Promise.resolve(99),
    frontWindow: () => Promise.resolve("stub-front"),
    post: (events: Rec[]) => {
      if (opts.postThrows === true) throw new Error("합성 rejection");
      const h = (desktop as { held: { keys: string[]; buttons: string[] } }).held;
      log.posts.push({ events, heldAtPost: { keys: [...h.keys], buttons: [...h.buttons] } });
      log.order.push("post");
      // 정리(놓기)와 본 발사를 구분한다 — 정리는 `mouseup`/`keyup` 뿐이다.
      const isRelease = events.every((e) => e["t"] === "keyup" || e["t"] === "mouseup");
      const ok = isRelease ? opts.releaseOk !== false : opts.postOk !== false;
      return Promise.resolve(
        ok
          ? { ok: true, fired: events.length, stdout: "" }
          : { ok: false, reason: "failed", detail: "합성 실패", stdout: "" },
      );
    },
  },
});

export const check: RegressionCheck = {
  name: "computer-use-wiring-runs",
  guards:
    "발사 전 거절인데 프레임을 버려서 «좌표를 고쳐 다시» 가 불가능해지던 것 · " +
    "이전 정리 실패분을 새 행동이 덮어써 눌린 키가 영영 안 풀리던 것 · " +
    "사후 장면이 행동한 화면이 아니라 주 모니터를 찍어 모델이 다른 화면으로 판정하던 것 · " +
    "정리보다 사후 관측이 먼저 와서 눌린 키가 찍힌 화면을 «선택됐다» 로 읽던 것 · " +
    "잔여 정리가 보호 구간 밖이라 예상 밖 rejection 이 리스를 영구 잠그던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { createTools, realWiring } = await loadPluginModule<IndexModule>(
      "../../../plugins/computer-use/src/index.ts",
    );
    const { newDesktop } = await loadPluginModule<ControlModule>(
      "../../../plugins/computer-use/src/control.ts",
    );

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cu-wiring-"));
    const host = { dataDir, log: () => {}, turn: { threadKey: "t1" } };
    const extra = { signal: new AbortController().signal };

    /** 한 판을 차린다 — 배선·기록·도구 둘. */
    const arena = (
      opts: { postOk?: boolean; postThrows?: boolean; releaseOk?: boolean } = {},
    ): { log: Log; desktop: Rec; look: ToolLike; doTool: ToolLike } => {
      const log: Log = { posts: [], captures: [], order: [] };
      const desktop = newDesktop();
      const stubs = makeStubs(log, desktop, opts);
      const w = { platform: "darwin", observe: stubs.observe, control: stubs.control, desktop };
      const tools = createTools(w, host);
      const look = tools.find((t) => t.name === "look");
      const doTool = tools.find((t) => t.name === "do");
      if (look === undefined || doTool === undefined) throw new Error("도구를 못 찾았다");
      return { log, desktop, look, doTool };
    };
    const frameIdOf = (r: { content: Array<Rec> }): string | null => {
      const text = r.content
        .filter((c) => c["type"] === "text")
        .map((c) => String(c["text"]))
        .join("\n");
      return /화면 id[^0-9a-f]*([0-9a-f]{8})/.exec(text)?.[1] ?? null;
    };

    // ── ① 정상 실행 — 순서와 **사후 장면** ────────────────────────────────────
    {
      const a = arena();
      const l = await a.look.handler({}, extra);
      const fid = frameIdOf(l);
      const d = await a.doTool.handler(
        { frameId: fid, steps: [{ t: "type", text: "가" }] },
        extra,
      );
      out.push(
        assert(
          "★`do` 가 **입력 뒤에 사후 관측**을 한다 — 순서가 뒤집히면 눌린 키가 찍힌 화면을 준다",
          a.log.order.join(">") === "capture>post>capture",
          a.log.order.join(">"),
        ),
      );
      out.push(
        assert(
          "★★사후 장면이 응답에 **그림으로** 실리고 **새 화면 id** 가 붙는다",
          d.content.some((c) => c["type"] === "image") && frameIdOf(d) !== null && frameIdOf(d) !== fid,
          `그림=${String(d.content.some((c) => c["type"] === "image"))} 새id=${String(frameIdOf(d))} 옛id=${String(fid)}`,
        ),
      );
    }

    // ── ①-b ★★**쏘는 순간** 장부에 «도중에 누르는 것» 이 올라 있다 ──────────────
    //  ★★클릭은 `down`→`up` 이 **한 열 안에서 짝이 맞으므로** 끝나면 남는 게 없다
    //   (`holds` 는 비어 있다). 그런데 자식이 **그 사이에서** 죽으면 버튼이 눌린 채 남는다.
    //   그래서 장부에 올라야 하는 것은 `holds` 가 아니라 **`touched`** 다.
    //  ★이 단언이 없으면 `touched → holds` 변이가 **통과한다**(실제로 통과시켰다) —
    //   짝이 안 맞는 열만 재면 둘이 같은 값이라 차이가 안 보인다.
    {
      const a = arena();
      const fid = frameIdOf(await a.look.handler({}, extra));
      await a.doTool.handler({ frameId: fid, steps: [{ t: "click", x: 10, y: 10 }] }, extra);
      const first = a.log.posts[0];
      out.push(
        assert(
          "★★클릭을 쏘는 **순간** 장부에 버튼이 올라 있다 — down↔up 사이에서 죽으면 그것만이 되돌릴 근거다",
          (first?.heldAtPost.buttons ?? []).includes("left"),
          `heldAtPost=${JSON.stringify(first?.heldAtPost ?? null)} (끝난 뒤가 아니라 쏠 때의 값)`,
        ),
      );
      out.push(
        assert(
          "그리고 짝이 맞았으므로 **끝나면 비어 있다**(정리가 헛돌지 않는다)",
          (a.desktop as { held: { buttons: string[] } }).held.buttons.length === 0,
          JSON.stringify((a.desktop as { held: unknown }).held),
        ),
      );
    }

    // ── ② 계획 실패 — **발사 0회 · 프레임 유지** ──────────────────────────────
    //  ★★거절 문구는 *"좌표를 고쳐 다시"* 라고 말한다. 종전엔 그 프레임을 **방금 자기가
    //   지운 채로** 그렇게 말했다 — 안내와 수명이 충돌했다.
    {
      const a = arena();
      const fid = frameIdOf(await a.look.handler({}, extra));
      const before = a.log.posts.length;
      const rej = await a.doTool.handler(
        { frameId: fid, steps: [{ t: "click", x: 99_999, y: 10 }] },
        extra,
      );
      out.push(
        assert(
          "★★그림 밖 좌표는 **아무것도 쏘지 않고** 거절된다(post 0회)",
          a.log.posts.length === before,
          `post ${String(a.log.posts.length - before)}회`,
        ),
      );
      out.push(
        assert(
          "★★거절 뒤에도 **같은 화면 id 로 다시 부를 수 있다** — 화면이 안 바뀌었으니 유효하다",
          (await a.doTool.handler({ frameId: fid, steps: [{ t: "click", x: 10, y: 10 }] }, extra)).content
            .length > 0 && a.log.posts.length === before + 1,
          `두 번째 호출의 post=${String(a.log.posts.length - before)}회 (거절이 프레임을 지웠으면 0이다)`,
        ),
      );
      out.push(
        assert(
          "거절 문구가 **무엇을 하라는지** 말한다",
          rej.content.some((c) => String(c["text"] ?? "").includes("좌표")),
          String(rej.content[0]?.["text"] ?? "").slice(0, 60),
        ),
      );
    }

    // ── ③ 발사 후 실패 — 정리가 **사후 관측보다 먼저** ────────────────────────
    {
      const a = arena({ postOk: false });
      const fid = frameIdOf(await a.look.handler({}, extra));
      await a.doTool.handler(
        { frameId: fid, steps: [{ t: "keydown", key: "shift" }] },
        extra,
      );
      const lastPost = a.log.order.lastIndexOf("post");
      const lastCapture = a.log.order.lastIndexOf("capture");
      out.push(
        assert(
          "★★실패해도 **정리를 먼저 하고** 사후 관측을 한다 — 키를 잡은 채 찍으면 관측이 오염된다",
          lastPost < lastCapture && a.log.order.join(">") === "capture>post>post>capture",
          a.log.order.join(">"),
        ),
      );
      out.push(
        assert(
          "★정리 입력은 **놓기뿐**이다(새로 누르지 않는다)",
          (a.log.posts[1]?.events ?? []).every((e) => e["t"] === "keyup" || e["t"] === "mouseup"),
          JSON.stringify((a.log.posts[1]?.events ?? []).map((e) => e["t"])),
        ),
      );
    }

    // ── ④ 정리 실패 → 다음 행동이 **새 입력을 안 낸다 · 장부 보존** ──────────
    //  ★★종전엔 새 행동이 `desktop.held` 에 **대입**해서 이전 미해제분을 잃었다.
    {
      const a = arena({ postOk: true, releaseOk: false });
      const fid = frameIdOf(await a.look.handler({}, extra));
      // 짝을 안 맞춘 열 → 끝나도 shift 가 눌린 채 남는다(정리는 실패하게 해 둔다).
      await a.doTool.handler({ frameId: fid, steps: [{ t: "keydown", key: "shift" }] }, extra);
      const held = (a.desktop as { held: { keys: string[] } }).held;
      out.push(
        assert(
          "★★정리가 실패하면 **장부에 남는다** — 다음 정리에서 다시 시도할 근거다",
          held.keys.includes("shift"),
          JSON.stringify(held),
        ),
      );
      const fid2 = frameIdOf(await a.look.handler({}, extra));
      const posts = a.log.posts.length;
      const blocked = await a.doTool.handler(
        { frameId: fid2, steps: [{ t: "click", x: 10, y: 10 }] },
        extra,
      );
      out.push(
        assert(
          "★★잔여를 못 놓으면 새 행동을 **거절한다**(그 상태로는 결과가 달라진다) — 새 입력 0회",
          String(blocked.content[0]?.["text"] ?? "").includes("눌린 채 남은 입력") &&
            a.log.posts.length === posts + 1,
          `${String(blocked.content[0]?.["text"] ?? "").slice(0, 40)} · 추가 post=${String(a.log.posts.length - posts)}회(정리 시도 1회뿐)`,
        ),
      );
      out.push(
        assert(
          "★거절 뒤에도 **장부가 그대로**다 — 조용히 사라지면 그 키는 영영 안 풀린다",
          (a.desktop as { held: { keys: string[] } }).held.keys.includes("shift"),
          JSON.stringify((a.desktop as { held: { keys: string[] } }).held),
        ),
      );
    }

    // ── ⑤ 예상 밖 rejection — **리스가 잠기지 않는다** ────────────────────────
    //  ★★`await` 가 던지면 `finally` 를 안 지나 `active` 가 영영 남고, 그 뒤 모든 호출이
    //   `busy-self` 로 막힌다 — 되돌릴 방법이 재시작뿐인 잠김이다.
    {
      const a = arena({ postThrows: true });
      const fid = frameIdOf(await a.look.handler({}, extra));
      let threw = false;
      try {
        await a.doTool.handler({ frameId: fid, steps: [{ t: "click", x: 10, y: 10 }] }, extra);
      } catch {
        threw = true;
      }
      // ★★**예외가 실제로 났는지를 따로 단언한다** (아스트라 3차 §5). `active === null` 은
      //  **초기값이기도 하다** — 의도한 경로에 도달조차 못 해도 통과한다. 「도달했다」와
      //  「풀렸다」는 다른 주장이라 다른 줄로 잰다.
      out.push(
        assert(
          "★의도한 **예외 경로에 실제로 도달**했다(도달 못 해도 통과하는 단언은 빈 단언이다)",
          threw,
          `던짐=${String(threw)} · post 기록=${String(a.log.posts.length)}회(던졌으니 0이어야)`,
        ),
      );
      out.push(
        assert(
          "★★실행부가 **던져도** 활성 행동이 풀린다 — 안 풀리면 이후 모든 호출이 busy-self 로 영구 차단된다",
          threw && (a.desktop as { active: unknown }).active === null,
          `active=${JSON.stringify((a.desktop as { active: unknown }).active)}`,
        ),
      );
    }

    // ── ⑥ 사후 관측이 **행동한 그 화면**을 본다 ───────────────────────────────
    {
      const a = arena();
      const fid = frameIdOf(await a.look.handler({ display: 2 }, extra));
      await a.doTool.handler({ frameId: fid, steps: [{ t: "type", text: "가" }] }, extra);
      const last = a.log.captures[a.log.captures.length - 1]?.target;
      out.push(
        assert(
          "★★보조 디스플레이에서 행동하면 **사후 관측도 그 디스플레이**다(주 화면으로 안 바뀐다)",
          JSON.stringify(last) === JSON.stringify({ kind: "display", index: 2 }),
          JSON.stringify(last),
        ),
      );
    }

    // ── ⑤-b **잔여 정리 중** 던져도 리스가 안 잠긴다 ─────────────────────────
    //  ★★이 경로가 한때 `try` **밖**에 있었다. 밖이면 이 `await` 가 던졌을 때 `finally` 를
    //   안 지나 `active` 가 영영 남고, 그 뒤 모든 호출이 `busy-self` 로 막힌다 —
    //   되돌릴 방법이 **재시작뿐인 잠김**이다.
    {
      const a = arena({ postThrows: true });
      // 잔여를 미리 심는다 — 그러면 첫 `await ctl.post` 가 **정리** 경로에서 일어난다.
      (a.desktop as { held: { keys: string[]; buttons: string[] } }).held = {
        keys: ["shift"],
        buttons: [],
      };
      a.desktop["frames"] = new Map([
        ["t1", [{ id: "aaaaaaaa", atMs: Date.now(), owner: "t1", front: null, target: { kind: "screen" }, geometry: { deliveredPx: { w: 100, h: 100 }, capturedPx: { w: 100, h: 100 }, originPt: { x: 0, y: 0 }, scale: 1 } }]],
      ]);
      let threw2 = false;
      try {
        await a.doTool.handler(
          { frameId: "aaaaaaaa", steps: [{ t: "click", x: 10, y: 10 }] },
          extra,
        );
      } catch {
        threw2 = true;
      }
      out.push(
        assert(
          "★★**잔여 정리 중** 던져도 활성 행동이 풀린다(이 경로가 보호 구간 밖이면 영구 잠김이다)",
          threw2 && (a.desktop as { active: unknown }).active === null,
          `던짐=${String(threw2)} · active=${JSON.stringify((a.desktop as { active: unknown }).active)}`,
        ),
      );
    }

    // ── §5 ★플랫폼별 **프리플라이트 실패 분기**가 실제로 돈다 (아스트라 4차 §5) ──
    //  ★★스텁이 늘 `ok:true` 라 이 분기는 **한 번도 안 돌았다.** Windows 에서 맥용 권한
    //   안내(«손쉬운 사용») 가 나가도 아무도 못 잡는다 — 그건 **있지도 않은 화면을 찾게**
    //   만드는 안내이고, 2026-09-18 에 실제로 그렇게 나갔던 부류다.
    for (const [plat, want, notWant] of [
      ["darwin", "손쉬운 사용", "데스크톱"],
      ["win32", "세션", "손쉬운 사용"],
    ]) {
      const log3: Log = { posts: [], captures: [], order: [] };
      const d3 = newDesktop();
      const st3 = makeStubs(log3, d3, {
        preflightFail: {
          reason: "no-permission",
          detail: plat === "win32" ? "데스크톱 세션이 없습니다" : "AXIsProcessTrusted=false",
        },
      });
      const tools3 = createTools(
        { platform: plat, observe: st3.observe, control: st3.control, desktop: d3 },
        host,
      );
      const do3 = tools3.find((t) => t.name === "do");
      if (do3 === undefined) throw new Error("do 를 못 찾았다");
      const r3 = await do3.handler(
        { frameId: "zzzzzzzz", steps: [{ t: "click", x: 1, y: 1 }] },
        extra,
      );
      const text3 = r3.content.map((c) => String(c["text"] ?? "")).join("\n");
      out.push(
        assert(
          `★[${plat}] 권한 프리플라이트 실패면 **아무것도 쏘지 않는다**`,
          log3.posts.length === 0,
          `post ${String(log3.posts.length)}회`,
        ),
      );
      out.push(
        assert(
          `★★[${plat}] **그 플랫폼에 맞는 안내**가 나간다 — 없는 화면을 찾게 만들면 안 된다`,
          text3.includes(want) && !text3.includes(notWant),
          `«${want}» 포함=${String(text3.includes(want))} · «${notWant}» 포함=${String(text3.includes(notWant))} → ${text3.slice(0, 60)}`,
        ),
      );
      out.push(
        assert(
          `[${plat}] 리스·활성 상태를 안 건드린다(거절은 상태를 남기지 않는다)`,
          (d3 as { active: unknown }).active === null,
          JSON.stringify((d3 as { active: unknown }).active),
        ),
      );
    }

    // ── §4 ★★**실제 배선이 상태를 공유한다** (아스트라 3차 §4) ────────────────
    //  ★이음매를 만든 뒤 «주입된 것» 만 재면 **제품의 연결**은 여전히 검사 밖이다.
    //   실제로 `desktop: newDesktop()` 으로 바꿔도 모든 검사가 통과했다 — 그러면 도구를
    //   새로 만들 때마다 프레임·장부가 사라지고, `look` 이 준 화면 id 를 `do` 가 모른다.
    out.push(
      assert(
        "★★실제 배선을 **두 번 얻어도 같은 데스크톱**이다 — 안 그러면 look 이 준 화면 id 를 do 가 모른다",
        realWiring().desktop === realWiring().desktop,
        `같은 객체=${String(realWiring().desktop === realWiring().desktop)} (데스크톱당 싱글턴 §3-3)`,
      ),
    );

    // ── §6 ★공통 계약은 **두 플랫폼 조건**으로 돈다 (아스트라 3차 §6) ────────────
    //  ★새 배선 회귀가 `darwin` 으로 **고정**돼 있었다 — Windows 분기는 한 번도 안 돌았다.
    //   실제 OS 입력 없이 스텁으로 되는 범위다.
    for (const plat of ["darwin", "win32"]) {
      const log2: Log = { posts: [], captures: [], order: [] };
      const d2 = newDesktop();
      const st2 = makeStubs(log2, d2);
      const tools2 = createTools(
        { platform: plat, observe: st2.observe, control: st2.control, desktop: d2 },
        host,
      );
      const look2 = tools2.find((t) => t.name === "look");
      const do2 = tools2.find((t) => t.name === "do");
      if (look2 === undefined || do2 === undefined) throw new Error("도구를 못 찾았다");
      const fid2 = frameIdOf(await look2.handler({}, extra));
      await do2.handler({ frameId: fid2, steps: [{ t: "click", x: 10, y: 10 }] }, extra);
      out.push(
        assert(
          `★[${plat}] 배선의 순서가 같다 — 관측 → 발사 → 사후 관측`,
          log2.order.join(">") === "capture>post>capture",
          log2.order.join(">"),
        ),
      );
    }

    await fs.rm(dataDir, { recursive: true, force: true });
    return out;
  },
};
