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
    /** ★가드가 **몇 번째 직전에** 멈추나 — 그 앞까지만 쏜 «정상 종료한 부분 실행». */
    guardStopAt?: number;
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
      // ★★**가드 중단은 «정상 종료한 부분 실행»** 이다 — `ok:true` 인데 열을 다 못 냈다.
      //  실행부(mac.ts·win.ts)가 그 사실을 **stdout 으로** 말하므로 여기서도 그렇게 낸다
      //  (반환값에 플래그를 더하면 제품이 안 쓰는 통로를 검사가 지어내는 것이 된다).
      if (!isRelease && opts.guardStopAt !== undefined) {
        const cut = opts.guardStopAt;
        return Promise.resolve({
          ok: true,
          fired: cut, // 멈추기 전까지는 실제로 쐈다
          stdout: `${JSON.stringify({ step: cut })}\n${JSON.stringify({ stopped: cut, why: "front-changed", saw: "B:2" })}`,
        });
      }
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
      opts: { postOk?: boolean; postThrows?: boolean; releaseOk?: boolean; guardStopAt?: number } = {},
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

    // ── ①-d ★★**가드가 멈춰도 손은 놓는다** (2026-09-20, 회사돌쇠 독립 검토) ──────────
    //  ★★전면 창 가드의 중단은 자식이 **«정상 종료» 하는 부분 실행**이다(`ok:true` + 멈춤).
    //   그래서 `keydown shift → keyup shift` 가 2번째 직전에 멈추면, **계획 전체로는 짝이
    //   맞아** `holds` 가 비어 있다 — 종전엔 `sent.ok` 만 보고 장부를 그 빈 값으로 줄인 **뒤에**
    //   결과를 읽었고, 그러면 바로 아래 정리가 «장부가 비었으니 놓을 것 없다» 로 건너뛴다.
    //   **물리 키는 shift 가 눌린 채인데 뗄 근거가 사라진다.**
    //  ★실측(아스트라 재현, 고침 전): `simulatedPhysicalKeys:["shift"]` · 빈 장부 · `postCalls:1`.
    //  ★★**아래 정리 블록의 주석은 이미 이 경우를 정확히 적고 있었다.** 가드가 틀린 게 아니라
    //   **그 앞 한 줄이 무력화**하고 있었다 — 변이로는 안 나오고 **순서**를 봐야 나온다.
    {
      const a = arena({ guardStopAt: 1 });
      const fid = frameIdOf(await a.look.handler({}, extra));
      const r = await a.doTool.handler(
        { frameId: fid, steps: [{ t: "keydown", key: "shift" }, { t: "keyup", key: "shift" }] },
        extra,
      );
      // 정리 발사는 `keyup`/`mouseup` 뿐인 post 다 — 본 발사와 구분해서 센다.
      const releases = a.log.posts.filter((p) =>
        p.events.length > 0 && p.events.every((e) => e["t"] === "keyup" || e["t"] === "mouseup"),
      );
      out.push(
        assert(
          "★★가드가 멈춘 뒤 **놓기 발사가 실제로 일어난다** — 안 하면 shift 가 사용자 기계에 남는다",
          releases.length === 1,
          `놓기 post ${String(releases.length)}회 · 전체 post ${String(a.log.posts.length)}회`,
        ),
      );
      out.push(
        assert(
          "★그 놓기가 **shift 를 떼는 것**이다(엉뚱한 키를 떼는 게 아니다)",
          releases[0]?.events.some((e) => e["t"] === "keyup" && e["key"] === "shift") === true,
          JSON.stringify(releases[0]?.events ?? []).slice(0, 90),
        ),
      );
      const heldAfter = (a.desktop as Rec)["held"] as { keys: string[]; buttons: string[] };
      out.push(
        assert(
          "★놓기가 성공했으면 장부도 비워진다 — 다음 행동이 또 떼려 들지 않는다",
          heldAfter.keys.length === 0 && heldAfter.buttons.length === 0,
          JSON.stringify(heldAfter),
        ),
      );
      out.push(
        assert(
          "★보고가 **어디서 멈췄는지** 말한다 — 「완료/미실행」이 사용자에게 보이는 판정이다",
          /미실행/.test(r.content.filter((c) => c["type"] === "text").map((c) => String(c["text"])).join("\n")),
          r.content.filter((c) => c["type"] === "text").map((c) => String(c["text"])).join(" ").slice(0, 80),
        ),
      );
    }

    // ── ①-e ★**막으면 안 되는 것 셋** — 과하게 놓지 않는다 ──────────────────────────
    //  ★아스트라 경계: *"입력 전 중단에도 무조건 모든 키를 해제하는 방식으로 단순화하지 마라."*
    //   그래서 반대편에도 못을 박는다 — 안 그러면 «늘 놓는다» 로 넓혀도 위 넷이 통과한다.
    {
      // (1) 정상 완주 — 짝이 맞았으니 **놓기가 아예 없어야** 한다
      const a1 = arena();
      const f1 = frameIdOf(await a1.look.handler({}, extra));
      await a1.doTool.handler(
        { frameId: f1, steps: [{ t: "keydown", key: "shift" }, { t: "keyup", key: "shift" }] },
        extra,
      );
      const rel1 = a1.log.posts.filter((p) =>
        p.events.length > 0 && p.events.every((e) => e["t"] === "keyup" || e["t"] === "mouseup"),
      );
      out.push(
        assert(
          "★반대 방향 — **정상 완주**엔 놓기 발사가 없다(이미 뗀 키를 또 떼면 유휴 시계가 헛리셋된다)",
          rel1.length === 0,
          `놓기 ${String(rel1.length)}회 · post ${String(a1.log.posts.length)}회`,
        ),
      );

      // (2) 한 번도 안 쐈다(`fired:0`) — 누른 것이 없으니 놓을 것도 없다
      const a2 = arena({ guardStopAt: 0 });
      const f2 = frameIdOf(await a2.look.handler({}, extra));
      await a2.doTool.handler(
        { frameId: f2, steps: [{ t: "keydown", key: "shift" }, { t: "keyup", key: "shift" }] },
        extra,
      );
      const rel2 = a2.log.posts.filter((p) =>
        p.events.length > 0 && p.events.every((e) => e["t"] === "keyup" || e["t"] === "mouseup"),
      );
      out.push(
        assert(
          "★반대 방향 — **입력 전 중단**(`fired:0`)엔 놓기가 없다 — 누른 적 없는 키에 keyup 을 쏘지 않는다",
          rel2.length === 0,
          `놓기 ${String(rel2.length)}회`,
        ),
      );

      // (3) 놓기가 실패하면 장부를 **지우지 않는다** — 다음 호출이 갚을 근거다
      const a3 = arena({ guardStopAt: 1, releaseOk: false });
      const f3 = frameIdOf(await a3.look.handler({}, extra));
      await a3.doTool.handler(
        { frameId: f3, steps: [{ t: "keydown", key: "shift" }, { t: "keyup", key: "shift" }] },
        extra,
      );
      const held3 = (a3.desktop as Rec)["held"] as { keys: string[]; buttons: string[] };
      out.push(
        assert(
          "★**놓기 실패면 장부를 안 지운다** — 그게 다음 호출이 갚을 유일한 근거다",
          held3.keys.includes("shift"),
          JSON.stringify(held3),
        ),
      );
    }

    // ── ①-c ★★**막다른 길이 없다** — `region` 은 줬는데 `frameId` 가 비면 ─────────────
    //  ★★이 자리에서 **두 번** 돌았다. 모델은 «필드를 빼라» 를 못 한다 — 스키마를 빈 값으로
    //   채워 보낸다(`region={0,0,1,1}, frameId:""`). 그래서 안내만 돌려주면 같은 인자가 다시
    //   오고, 그게 곧 무한 반복이다: **720번·101분**(2026-09-18) → 안내문으로 «고침» →
    //   **39번·2시간 15분**(2026-09-20, 정태님 기계에서 실측).
    //  ★그래서 재는 것은 «좋은 안내문이 오는가» 가 아니라 **«다음 수가 손에 쥐어지는가»** 다:
    //   그림이 실리고 **새 화면 id** 가 붙어야 다음 호출이 저절로 성립한다.
    //  ★변이로 확인할 것 — 이 블록을 옛 `textOnly(안내)` 로 되돌리면 둘 다 빨개져야 한다.
    {
      const a = arena();
      const r = await a.look.handler(
        { display: 1, region: { x: 0, y: 0, width: 1, height: 1 }, frameId: "" },
        extra,
      );
      const hasImage = r.content.some((c) => c["type"] === "image");
      const newId = frameIdOf(r);
      out.push(
        assert(
          "★★`frameId` 가 비어도 **막다른 길이 아니다** — 전체 화면 그림이 실려 온다",
          hasImage,
          `그림=${String(hasImage)} · content=${r.content.map((c) => String(c["type"])).join(",")}`,
        ),
      );
      out.push(
        assert(
          "★★그리고 **새 화면 id** 가 붙는다 — 그게 없으면 다음 호출이 또 같은 자리로 온다",
          newId !== null,
          `새 id=${String(newId)}`,
        ),
      );
      // ★**막으면 안 되는 것 하나** — 제대로 준 `region`+`frameId` 는 여전히 그 영역을 찍어야
      //  한다. 위 고침이 «`region` 을 늘 무시» 로 넓어지면 확대가 통째로 죽는다.
      const full = frameIdOf(await a.look.handler({}, extra));
      const zoom = await a.look.handler(
        { region: { x: 0, y: 0, width: 8, height: 8 }, frameId: full },
        extra,
      );
      const zoomed = a.log.captures.at(-1)?.target;
      out.push(
        assert(
          "★반대 방향 — 제대로 준 `region`+`frameId` 는 **그 영역**을 찍는다(확대가 안 죽는다)",
          zoom.content.some((c) => c["type"] === "image") && zoomed?.["kind"] === "region",
          `마지막 대상 kind=${String(zoomed?.["kind"])}`,
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
