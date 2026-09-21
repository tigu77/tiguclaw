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
  /** ★«다음 수» 문장을 만드는 제품 함수 — 검사가 **같은 함수로** 기댓값을 만든다(낱말 금지). */
  nextAfterCapture: (frameId: string | undefined, hasImage: boolean) => string;
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
    captureText?: () => string;
    front?: () => string;
    postOk?: boolean;
    postThrows?: boolean;
    /** ★가드가 **몇 번째 직전에** 멈추나 — 그 앞까지만 쏜 «정상 종료한 부분 실행». */
    guardStopAt?: number;
    /** ★«사람이 쓰는 중» 을 만들기 위한 유휴 초(작으면 가드가 막는다). */
    idle?: number;
    /** ★권한 확인이 느린 상황(Windows 프로세스 호출) — 계측이 그 구간을 잡는지 본다. */
    preflightDelayMs?: number;
    releaseOk?: boolean;
    /** 조작 권한 프리플라이트를 **실패**시킨다 — 그 분기가 실제로 도는지 보려고. */
    preflightFail?: { reason: string; detail: string };
    /**
     * ★캡처가 돌려줄 **바이트 수** (2026-09-21 적대 검토 G1).
     * 종전 stub 은 `bytes: 10` 고정이라 `FRAME_MAX_BYTES` 초과 가지가 **한 번도 안 돌았다** —
     * 그래서 「그림 없이 무엇을 말하나」를 되돌리는 변이가 4,237건을 전부 통과했다.
     */
    captureBytes?: number;
    /**
     * ★관측 프리플라이트가 **N번째 호출부터 화면 목록을 못 준다**(mac `displays()` 일시 실패).
     * 그림은 실리는데 **프레임이 등록되지 않는** 길이라, «그림 있음»과 «id 있음»이 갈린다.
     * ★«처음부터 실패» 가 아니라 **«도중에 실패»** 여야 한다 — 그래야 `look` 으로 받은 id 로
     *  `do` 를 부를 수 있고, 그 **사후** 캡처에서만 기하가 빠진다(실제 사고의 모양).
     */
    noScreensFrom?: number;
  } = {},
): { observe: Rec; control: Rec } => {
  let preflights = 0;
  return {
  observe: {
    preflight: () => {
      preflights += 1;
      return Promise.resolve({
        ok: true,
        screens: opts.noScreensFrom !== undefined && preflights >= opts.noScreensFrom ? undefined : [
          { x: 0, y: 0, w: 1920, h: 1080, scale: 1 },
          { x: 1920, y: 0, w: 1920, h: 1080, scale: 1 },
        ],
      });
    },
    capture: async (target: Rec, outPath: string) => {
      log.captures.push({ target });
      log.order.push("capture");
      // 실제 파일을 만든다 — 배관이 `stat`·`readFile` 을 지나야 «사후 장면» 이 성립한다.
      await fs.writeFile(outPath, opts.captureText?.() ?? "stub-frame");
      return { ok: true, bytes: opts.captureBytes ?? 10, longEdge: 1600, path: outPath, deliveredPx: { w: 1600, h: 900 } };
    },
  },
  control: {
    controlPreflight: async () => {
      // ★**모의 지연** — 실제로 몇 초 기다리지 않는다(인계서 ②: 테스트가 시계를 쓰면 안 된다).
      if (opts.preflightDelayMs !== undefined) await new Promise((r) => setTimeout(r, opts.preflightDelayMs));
      return (
        opts.preflightFail === undefined
          ? { ok: true }
          : { ok: false, reason: opts.preflightFail.reason, detail: opts.preflightFail.detail }
      );
    },
    idleSeconds: () => Promise.resolve(opts.idle ?? 99),
    frontWindow: () => Promise.resolve(opts.front?.() ?? "stub-front"),
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
  };
};

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
    const { createTools, realWiring, nextAfterCapture } = await loadPluginModule<IndexModule>(
      "../../../plugins/computer-use/src/index.ts",
    );
    const { newDesktop } = await loadPluginModule<ControlModule>(
      "../../../plugins/computer-use/src/control.ts",
    );

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cu-wiring-"));
    // ★호스트 로그를 **담는다** — 계측 줄(`권한확인 Nms…`)이 그 구간을 실제로 재는지
    //  보려면 버리면 안 된다. 아레나마다 새 배열을 준다.
    const hostLines: string[] = [];
    const host = { dataDir, log: (m: string) => hostLines.push(String(m)), turn: { threadKey: "t1" } };
    const extra = { signal: new AbortController().signal };

    /** 한 판을 차린다 — 배선·기록·도구 둘. */
    const arena = (
      opts: { captureText?: () => string; front?: () => string; postOk?: boolean; postThrows?: boolean; releaseOk?: boolean; guardStopAt?: number; idle?: number; preflightDelayMs?: number; captureBytes?: number; noScreensFrom?: number } = {},
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
    // ── ★**부품: `nextAfterCapture` 자체의 의미** (2026-09-21 3R) ──────────────────
    //  ★구조 그물(`saysNextFromOnePlace`)은 «한 곳에서 나오나» 만 본다 — 기댓값을 **그
    //   함수로** 만들기 때문에, 그 함수 안을 바꾸는 변이는 동어반복으로 통과한다.
    //   그래서 네 조합의 **의미**를 여기서 따로 못 박는다. 이음매와 부품은 다른 그물이다.
    {
      const withId = nextAfterCapture("abcd1234", true);
      const withIdNoPic = nextAfterCapture("abcd1234", false);
      const noId = nextAfterCapture(undefined, true);
      out.push(
        assert(
          "★부품: id 가 있으면 **그 id 를 글자 그대로** 말한다",
          withId.includes("abcd1234") && withIdNoPic.includes("abcd1234"),
          `${withId.slice(0, 60)} / ${withIdNoPic.slice(0, 60)}`,
        ),
      );
      out.push(
        assert(
          "★★부품: **그림이 없으면 «아래 그림 기준으로 읽어라»라고 하지 않는다**(불가능한 지시)",
          !/아래 그림 기준/.test(withIdNoPic) && /아래 그림 기준/.test(withId),
          withIdNoPic.slice(0, 120),
        ),
      );
      out.push(
        assert(
          "★★부품: 그림이 없으면 **옛 좌표를 쓰지 말라**고 말한다(오클릭이 비가역이다)",
          /옛 좌표를 그대로 쓰지 마세요/.test(withIdNoPic),
          withIdNoPic.slice(0, 120),
        ),
      );
      out.push(
        assert(
          "★부품: id 가 없으면 **그 사실을 말하고** 어떤 id 도 가리키지 않는다",
          /쓸 수 있는 화면 id 를 내지 못했습니다/.test(noId) && !/새 id/.test(noId),
          noId.slice(0, 120),
        ),
      );
    }

    /**
     * ★★**다음 수 문장은 «한 곳»에서만 나온다** — 그것을 구조로 잰다 (2026-09-21 3R).
     *
     * 세 라운드 내리 같은 일이 벌어졌다: 내가 문구를 고치면 **낱말을 보던 단언이 조용히
     * 어긋나거나 무장 해제**됐다. 그물이 문구를 쫓아다닌 것이다.
     * ★그래서 낱말이 아니라 **출처**를 잰다 — 그 답의 «다음 수» 는 실제 (id, 그림) 으로
     *  `nextAfterCapture` 를 부른 결과와 **글자 그대로 같아야** 한다. 어느 문이든 문장을
     *  손으로 쓰는 순간(=판정이 두 곳이 되는 순간) 빨개진다.
     */
    const saysNextFromOnePlace = (r: { content: Array<Rec> }): boolean =>
      r.content
        .filter((c) => c["type"] === "text")
        .map((c) => String(c["text"]))
        .join("\n")
        .includes(
          nextAfterCapture(
            frameIdOf(r) ?? undefined,
            r.content.some((c) => c["type"] === "image"),
          ),
        );

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

    // 반복 관측은 근거를 알릴 뿐 차단하지 않는다. 대상 변경·조작 뒤엔 누적을 끊는다.
    {
      const a = arena();
      const textOf = (r: { content: Array<Rec> }) => r.content
        .filter(c => c["type"] === "text").map(c => String(c["text"])).join("\n");
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await a.look.handler({ display: 1 }, extra));
      out.push(assert(
        "동일 화면 3회부터 관측 참고를 주지만 4회째도 이미지와 id를 반환한다",
        !textOf(results[1]!).includes("관측 참고:") && textOf(results[2]!).includes("3회 연속") &&
          textOf(results[3]!).includes("4회 연속") && frameIdOf(results[3]!) !== null &&
          results[3]!.content.some(c => c["type"] === "image"),
        textOf(results[3]!).slice(-280),
      ));
      const changed = await a.look.handler({ display: 2 }, extra);
      out.push(assert(
        "이미지 바이트가 같아도 대상 디스플레이가 바뀌면 반복으로 세지 않는다",
        !textOf(changed).includes("관측 참고:"), textOf(changed).slice(-280),
      ));
      const done = await a.doTool.handler(
        { frameId: frameIdOf(changed), steps: [{ t: "click", x: 5, y: 5 }] }, extra,
      );
      out.push(assert(
        "관측 안내 후에도 do가 실행되고 사후 화면은 새 연속 관측의 시작이다",
        a.log.posts.length === 1 && !textOf(done).includes("관측 참고:"),
        JSON.stringify({ posts: a.log.posts.length, tail: textOf(done).slice(-100) }),
      ));
    }

    {
      let picture = "one";
      let front = "first";
      const a = arena({ captureText: () => picture, front: () => front });
      const note = (r: { content: Array<Rec> }) => r.content.some(
        c => c["type"] === "text" && String(c["text"]).includes("관측 참고:"),
      );
      for (let i = 0; i < 3; i++) await a.look.handler({}, extra);
      picture = "two";
      const changedImage = await a.look.handler({}, extra);
      await a.look.handler({}, extra);
      const repeated = await a.look.handler({}, extra);
      front = "second";
      const changedWindow = await a.look.handler({}, extra);
      out.push(assert(
        "이미지가 달라지거나 같은 이미지라도 전면 창이 바뀌면 반복 안내가 초기화된다",
        !note(changedImage) && note(repeated) && !note(changedWindow),
        JSON.stringify({ changedImage: note(changedImage), repeated: note(repeated), changedWindow: note(changedWindow) }),
      ));
    }

    // Windows 실측보다 여유 있는 1시간 준비 후에도 실제 do 배선이 입력까지 도달해야 한다.
    // 실제 대기는 하지 않고 관측 프레임 시각만 이동한다. 실행부는 대역이라 OS 입력은 없다.
    {
      const a = arena();
      const l = await a.look.handler({}, extra);
      const fid = frameIdOf(l);
      const frames = a.desktop["frames"] as Map<string, Array<{ atMs: number }>>;
      for (const list of frames.values()) for (const fr of list) fr.atMs -= 3_600_000;
      const d = await a.doTool.handler(
        { frameId: fid, steps: [{ t: "click", x: 100, y: 100 }] },
        extra,
      );
      out.push(assert(
        "★1시간 준비한 조작도 실행하고 사후 화면을 반환한다 — 만료 재촬영 루프로 보내지 않는다",
        a.log.posts.length === 1 && a.log.order.join(">") === "capture>post>capture" &&
          d.content.some((c) => c["type"] === "image") && frameIdOf(d) !== fid,
        a.log.order.join(">"),
      ));
    }

    // ── ①-i ★계측이 **권한 확인 구간을 실제로 잡는가** (보완 인계서 ②) ───────────────
    //  ★첫 판은 `controlPreflight` **뒤에** 시각을 잡아서, 로그의 «검사까지» 가 do 진입부터가
    //   아니었다. Windows 는 권한 확인이 프로세스 호출이라 거기서 예산을 먹을 수 있는데
    //   그 구간이 통째로 빠졌다. **모의 지연**으로 잰다 — 실제로 몇 초 기다리지 않는다.
    {
      hostLines.length = 0;
      const a = arena({ preflightDelayMs: 120 });
      const fid = frameIdOf(await a.look.handler({}, extra));
      // 시간 만료 대신 알려지지 않은 id 거절 경로에서 검사 시간을 측정한다.
      (a.desktop["frames"] as Map<string, unknown>).clear();
      await a.doTool.handler({ frameId: fid, steps: [{ t: "click", x: 1, y: 1 }] }, extra);
      const line = hostLines.find((l) => l.includes("권한확인")) ?? "";
      const ms = Number(/권한확인 (\d+)ms/.exec(line)?.[1] ?? "-1");
      out.push(
        assert(
          "★★계측이 **권한 확인 구간을 포함**한다 — 그 앞에서 시각을 잡으면 이 시간이 사라진다",
          ms >= 100,
          `권한확인=${String(ms)}ms (모의 지연 120ms) · ${line.slice(-70)}`,
        ),
      );
      const total = Number(/do진입→판정 (\d+)ms/.exec(line)?.[1] ?? "-1");
      out.push(
        assert(
          "★그리고 **합이 총시간에 들어간다** — 구간 이름과 재는 구간이 어긋나면 안 된다",
          total >= ms,
          `총 ${String(total)}ms ≥ 권한확인 ${String(ms)}ms`,
        ),
      );
    }

    // ── ①-h ★★**함수가 아니라 배선으로 잰다** (2026-09-20, 보완 인계서 ③) ──────────
    //  ★지적: 새 검사들이 `normalizeKey`·`frameRejection` 을 **직접** 부른다. 그래서
    //   `toStep` 에서 정규화 호출을 빼거나 호출부에서 `gaveImage:true` 를 빼도 **못 본다.**
    //   계약은 «함수가 옳다» 가 아니라 «**실제 `do` 가 그렇게 흐른다**» 이다.
    {
      const a = arena();
      const fid = frameIdOf(await a.look.handler({}, extra));
      await a.doTool.handler(
        {
          frameId: fid,
          steps: [
            { t: "keydown", key: "CTRL" },
            { t: "keydown", key: "Shift" },
            { t: "type", text: "Ab" },
            { t: "keyup", key: "Shift" },
            { t: "keyup", key: "CTRL" },
          ],
        },
        extra,
      );
      const fired = a.log.posts.find((p) => p.events.some((e) => e["t"] === "keydown"));
      const keys = (fired?.events ?? []).filter((e) => e["t"] === "keydown" || e["t"] === "keyup").map((e) => String(e["key"]));
      out.push(
        assert(
          "★★**실제 발사 이벤트의 키가 정규화돼 있다** — `CTRL`·`Shift` 가 소문자로 나간다",
          keys.length > 0 && keys.every((k) => k === k.toLowerCase()),
          `발사 키: ${keys.join(",")}`,
        ),
      );
      out.push(
        assert(
          "★**`type` 본문은 안 바뀐다** — 키 정규화가 글자를 건드리면 안 된다",
          // ★`type` 은 발사부에서 `unicode` 이벤트가 된다 — **제품이 실제로 내는 모양**으로 잰다.
          (fired?.events ?? []).some((e) => e["t"] === "unicode" && String(e["text"]) === "Ab"),
          JSON.stringify((fired?.events ?? []).filter((e) => e["t"] === "unicode")),
        ),
      );
      // ★장부에도 **같은 값**이 올라야 한다 — 검증만 소문자로 하고 장부에 원문을 담으면
      //  «누른 키» 와 «뗄 키» 가 갈려 미아가 생긴다.
      const held = fired?.heldAtPost.keys ?? [];
      out.push(
        assert(
          "★★장부에도 **정규화된 같은 값**이 올라간다 — 갈리면 해제가 남의 키를 놓는다",
          held.length > 0 && held.every((k) => k === k.toLowerCase()),
          `장부: ${held.join(",")}`,
        ),
      );
    }
    {
      // ★mac 에서는 `WIN` 이 **발사 전에** 거절되고 post 가 **0회** 여야 한다.
      const a = arena();
      const fid = frameIdOf(await a.look.handler({}, extra));
      const r = await a.doTool.handler(
        { frameId: fid, steps: [{ t: "keydown", key: "WIN" }] },
        extra,
      );
      const txt = r.content.filter((c) => c["type"] === "text").map((c) => String(c["text"])).join("\n");
      out.push(
        assert(
          "★★mac 에서 `WIN` 은 **쏘기 전에** 거절된다 — 대문자로 우회되지 않는다",
          a.log.posts.length === 0 && /낼 수 없습니다/.test(txt),
          `발사 ${String(a.log.posts.length)}회 · ${txt.slice(0, 40)}`,
        ),
      );
      out.push(
        assert(
          "★그 거절은 «화면을 다시 찍어도 안 풀린다» 고 말한다 — 관측으로 복구하지 않게",
          /화면을 다시 찍어도 풀리지 않습니다/.test(txt),
          txt.slice(-46),
        ),
      );
    }
    {
      // ★**무효화된 id** 로 부르면(행동 뒤 옛 id) 새 그림이 오고 재관측 지시는 **없어야** 한다.
      const a = arena();
      const fid = frameIdOf(await a.look.handler({}, extra));
      await a.doTool.handler({ frameId: fid, steps: [{ t: "click", x: 3, y: 3 }] }, extra);
      const r = await a.doTool.handler({ frameId: fid, steps: [{ t: "click", x: 4, y: 4 }] }, extra);
      const txt = r.content.filter((c) => c["type"] === "text").map((c) => String(c["text"])).join("\n");
      out.push(
        assert(
          "★★무효화된 id 에도 **새 그림 + 새 id** 가 오고, **재관측 지시는 없다**",
          r.content.some((c) => c["type"] === "image") &&
            frameIdOf(r) !== null &&
            !/look` 으로 (다시|지금)/.test(txt),
          `그림=${String(r.content.some((c) => c["type"] === "image"))} 새id=${String(frameIdOf(r))} · ${txt.slice(0, 40)}`,
        ),
      );
    }

    // ── ①-g ★그물 보강 — 적대 검토가 통과시킨 변이들 (2026-09-20) ───────────────────
    //  ★검토자가 이 셋을 통과시켰다: `keepFrames: true`(F6) · `blocked` 안 세기(F7) ·
    //   `look` 의 낡은 프레임 막다른 길(F8). 전부 «편의 방향» 은 지키는데 **안전 방향**
    //   또는 «다음 수» 가 안 지켜지던 자리다.
    {
      // (1) ★★**행동은 자기 프레임을 무효화한다** — §14-3 의 핵심 불변식인데 그물이
      //  **한쪽만** 봤다. `keepFrames: false` 로 되돌리는 변이는 즉시 빨강인데,
      //  `keepFrames: true` 로 **끄는** 변이는 6/6 초록이었다. 끄면 모델이 누른 뒤에도
      //  **옛 좌표로 계속 누른다**(수명이 다할 때까지).
      const a = arena();
      const fid = frameIdOf(await a.look.handler({}, extra));
      await a.doTool.handler({ frameId: fid, steps: [{ t: "click", x: 5, y: 5 }] }, extra);
      const after = await a.doTool.handler(
        { frameId: fid, steps: [{ t: "click", x: 6, y: 6 }] },
        extra,
      );
      const txt = after.content.filter((c) => c["type"] === "text").map((c) => String(c["text"])).join("\n");
      out.push(
        assert(
          "★★**쏜 뒤엔 그 화면 id 가 죽는다** — 살려 두면 누른 뒤에도 옛 좌표로 계속 누른다",
          /오래됐|모르는|무효|다시/.test(txt) && a.log.posts.filter((p) => p.events.length > 0).length === 1,
          `두 번째 발사 ${String(a.log.posts.length - 1)}회 · ${txt.slice(0, 44)}`,
        ),
      );
    }
    {
      // (2) ★`blocked` 가 **소유자별로** 오른다 — 한 칸이면 둘이 번갈아 막힐 때 영영 안 오른다.
      const a = arena({ idle: 0 });
      const d = a.desktop as Rec;
      const blocked = d["blocked"] as Map<string, { reason: string; n: number }>;
      await a.doTool.handler({ frameId: "x", steps: [{ t: "click", x: 1, y: 1 }] }, extra);
      await a.doTool.handler({ frameId: "x", steps: [{ t: "click", x: 1, y: 1 }] }, extra);
      out.push(
        assert(
          "★★같은 소유자가 연달아 막히면 **연속이 오른다** — 안 오르면 승급이 영영 안 걸린다",
          // ★소유자 이름을 리터럴로 적지 않는다 — 아레나가 바꾸면 검사가 조용히 공짜 초록이 된다.
          a.log.posts.length === 0 && blocked.size === 1 && [...blocked.values()].every((v) => v.n >= 2),
          `발사=${a.log.posts.length} · 키=${[...blocked.keys()].join(",")} · 연속=${[...blocked.values()].map((v) => String(v.n)).join(",")}`,
        ),
      );
    }

    // 보관에서 제거된 화면은 시간 제한 없이도 거절하고 새 그림으로 복구한다.
    {
      const a = arena();
      const fid = frameIdOf(await a.look.handler({}, extra));
      (a.desktop["frames"] as Map<string, unknown>).clear();
      const r = await a.doTool.handler(
        { frameId: fid, steps: [{ t: "click", x: 10, y: 10 }] },
        extra,
      );
      const text = r.content.filter((c) => c["type"] === "text").map((c) => String(c["text"])).join("\n");
      out.push(
        assert(
          "★★보관되지 않은 화면 id 로 부르면 **새 그림이 같이 온다** — 거절만 하면 왕복이 고리가 된다",
          r.content.some((c) => c["type"] === "image"),
          `content=${r.content.map((c) => String(c["type"])).join(",")}`,
        ),
      );
      out.push(
        assert(
          "★그 그림에 **새 화면 id** 가 붙고, 옛 id 와 다르다",
          frameIdOf(r) !== null && frameIdOf(r) !== fid,
          `새=${String(frameIdOf(r))} 옛=${String(fid)}`,
        ),
      );
      out.push(
        assert(
          // ★**«좌표를 다시 읽어라» 를 낱말로 재지 않는다** (2026-09-21 3R). 종전엔 `/다시 읽어야/`
          //  였는데, 제품 문구를 고치자 조용히 어긋났다 — 그리고 낱말 목록은 문구를 바꾸면
          //  **무장 해제**된다(같은 라운드 G2). 정확한 값이 이미 있으니 그걸 쓴다:
          //  제품이 그 자리에 넣는 문장을 **같은 함수로 만들어** 대조한다.
          "★**행동은 대신 실행하지 않는다** — 좌표는 옛 그림 기준이라 새 화면에선 딴 곳일 수 있다",
          a.log.posts.length === 0 &&
            text.includes(
              nextAfterCapture(
                frameIdOf(r) ?? undefined,
                r.content.some((c) => c["type"] === "image"),
              ),
            ),
          `발사 ${String(a.log.posts.length)}회 · ${text.slice(0, 50)}`,
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
    // ── ★«다음 수» 는 **그림이 아니라 화면 id** 로 정해진다 (2026-09-21 적대 검토 P1·P2·G1) ──
    //  ★종전 stub 은 캡처가 **언제나 성공**이라(bytes 고정·screens 고정) 아래 두 길이 한 번도
    //   안 돌았다. 그래서 이 판정을 통째로 되돌리는 변이가 4,237건을 전부 통과했다 —
    //   **핵심 수정이 그물 밖**이었다. 손잡이 둘을 달아 실제로 지나게 한다.
    {
      const textOf = (r: { content: Array<Rec> }): string =>
        r.content.filter((c) => c["type"] === "text").map((c) => String(c["text"])).join("\n");
      const hasImage = (r: { content: Array<Rec> }): boolean =>
        r.content.some((c) => c["type"] === "image");
      const press = { steps: [{ t: "click", x: 20, y: 20 }] };

      // ㉮ 바이트 상한 초과 — **그림은 없는데 화면 id 는 유효하다**(등록이 그 검사보다 먼저).
      //    실측 사고: 「전부 무효」라고 말해놓고 같은 답에 쓸 수 있는 id 를 실어 보냈고,
      //    그 처방인 `look` 은 같은 오버사이즈를 다시 받아 루프가 됐다.
      {
        const a = arena({ captureBytes: 2_000_000 });
        const seen = await a.look.handler({}, extra);
        const id = frameIdOf(seen);
        const r = await a.doTool.handler({ ...press, frameId: id ?? "x" }, extra);
        const t = textOf(r);
        out.push(assert("㉮ 상한 초과 — 그림이 없다(전제)", !hasImage(r), String(hasImage(r))));
        out.push(
          assert(
            "★㉮ 그림이 없어도 **쓸 수 있는 id 가 있으면 그 id 를 쓰라**고 한다",
            /새 id/.test(t) && !/`look` 으로 다시 보고/.test(t),
            t.slice(-150),
          ),
        );
        const said = /새 id \s*`?([0-9a-f]{8})`?/.exec(t)?.[1];
        out.push(
          assert(
            "★㉮ 그 답이 **가리키는 id 가 실제로 그 답에 있다**(없는 것을 가리키지 않는다)",
            said !== undefined && said === frameIdOf(r),
            `${t.slice(-110)} / meta=${String(frameIdOf(r))}`,
          ),
        );
        // ★★**«쓸 수 있다» 는 글자 맞추기가 아니라 `frameCheck` 통과다** (2026-09-21 2R).
        //  종전 단언은 문구와 메타가 같은 값을 말하는지만 봤다. 그러면 제품이 **등록도
        //  안 된 id** 를 양쪽에 똑같이 적기만 해도 통과한다(검토자의 W1·W3 변이가 그렇게
        //  4,241건을 전부 지나갔다). 그래서 **그 id 로 실제로 조작이 나가는지**를 잰다.
        {
          const again = await a.doTool.handler({ ...press, frameId: said ?? "x" }, extra);
          const posted = a.log.posts.length;
          out.push(
            assert(
              "★★㉮ 그 id 로 **조작이 실제로 나간다**(약속이 말뿐이 아니다)",
              posted >= 2 && !/그 화면|모릅니다|쓸 수 없/.test(
                again.content.filter((c) => c["type"] === "text").map((c) => String(c["text"])).join(""),
              ),
              `posts=${String(posted)}`,
            ),
          );
        }
      }

      // ㉰ ★**`look` 쪽 두 문도 같은 술어를 쓴다** (2026-09-21 2R). 종전엔 `do` 만 덮여
      //    있어서, `look` 의 판정을 되돌리거나 넓히는 변이가 그대로 통과했다 — 「한 규칙이
      //    여러 문에 필요한데 한 문만」 이 그물에서도 똑같이 일어났다.
      {
        // ㉰-1 `look(region)` 인데 frameId 가 없다 → 전체를 찍어 주는 구제 경로.
        //      기하를 못 읽으면 **id 를 약속하면 안 된다**(그 경로가 「39회·2시간 15분」을
        //      닫으려고 만든 자리라, 여기서 막다른 길이 되면 그 사고가 되돌아온다).
        const a = arena({ noScreensFrom: 1 });
        const r = await a.look.handler({ region: { x: 0, y: 0, w: 10, h: 10 } }, extra);
        const t = textOf(r);
        out.push(
          assert(
            "★㉰-1 전제 — 기하를 못 읽으면 `look` 도 화면 id 를 못 낸다",
            frameIdOf(r) === null,
            `id=${String(frameIdOf(r))}`,
          ),
        );
        out.push(
          assert(
            "★★㉰-1 그때 `look` 은 **«이 그림의 화면 id 를 주세요»라고 하지 않는다**",
            !/«화면 id» 를 `?frameId`? 로 주고/.test(t),
            t.slice(0, 160),
          ),
        );
        out.push(
          assert(
            "★★㉰-1 look·region 구제 — 다음 수 문장이 **한 곳(`nextAfterCapture`)에서 나온다**",
            saysNextFromOnePlace(r),
            textOf(r).slice(-140),
          ),
        );
      }
      {
        // ㉰-2 ★**`look` 이 말한 id 는 실제로 통해야 한다.** 등록 판정을 «아무 프레임이나
        //      있나» 로 넓히면 `look` 은 id 를 말하는데 `do` 가 «그 화면을 모릅니다» 로
        //      거절한다 — 101분 루프의 모양이다. 글자가 아니라 **통하는지**로 잰다.
        const a = arena();
        const l = await a.look.handler({}, extra);
        const id = frameIdOf(l);
        const before = a.log.posts.length;
        const d = await a.doTool.handler({ ...press, frameId: id ?? "x" }, extra);
        out.push(
          assert(
            "★★㉰-2 `look` 이 알려준 화면 id 로 **조작이 실제로 나간다**",
            id !== null &&
              a.log.posts.length > before &&
              !/그 화면|모릅니다|쓸 수 없/.test(textOf(d)),
            `id=${String(id)} posts=${String(before)}→${String(a.log.posts.length)}`,
          ),
        );
      }

      {
        // ㉰-3 ★**«이 프레임» 과 «아무 프레임» 을 가른다.** `endAction` 이 프레임을 비우면
        //      맵 항목은 **빈 배열로 남는다** — 그래서 «맵에 owner 가 있나» 로 재면 참이
        //      되고, 등록도 안 된 id 를 «쓰세요» 라고 말하게 된다(101분 루프의 모양).
        const a = arena({ noScreensFrom: 3 });
        const l1 = await a.look.handler({}, extra); // 1회차 — 등록된다(맵 항목 생김)
        await a.doTool.handler({ ...press, frameId: frameIdOf(l1) ?? "x" }, extra); // 2회차 사후
        const l3 = await a.look.handler({}, extra); // 3회차 — 기하 실패
        out.push(
          assert(
            "★★㉰-3 옛 프레임이 비워진 뒤 기하가 실패하면 **id 를 말하지 않는다**",
            frameIdOf(l3) === null,
            `id=${String(frameIdOf(l3))}`,
          ),
        );
      }
      {
        // ㉰-4 ★`do` 의 **프레임 거절** 문(모르는 id)도 같은 술어를 써야 한다. 거절하면서
        //      새 화면을 주는데, 그 새 화면에 id 가 없으면 «아래 그림의 화면 id 로 다시»
        //      가 없는 것을 가리킨다.
        const a = arena({ noScreensFrom: 1 });
        const r = await a.doTool.handler({ ...press, frameId: "deadbeef" }, extra);
        const t = textOf(r);
        out.push(
          assert(
            "★㉰-4 전제 — 거절 경로의 재관측도 기하 실패면 id 가 없다",
            frameIdOf(r) === null,
            `id=${String(frameIdOf(r))}`,
          ),
        );
        out.push(
          assert(
            "★★㉰-4 그때 «아래 그림의 «화면 id» 로 다시 부르세요» 라고 하지 않는다",
            !/아래 그림의 «화면 id»/.test(t),
            t.slice(0, 160),
          ),
        );
      }

      {
        // ㉰-5 ★**거절 경로 + 상한 초과** — 여기서 「그림 없음」과 「id 없음」이 갈린다.
        //      재관측이 그림은 못 싣지만 **id 는 유효**하다. 종전 판정(「그림이 있나」)은
        //      그때 id 를 통째로 버리고 «`look` 으로 다시» 라고 했다(적대 검토 P2) —
        //      한 왕복이 통째로 낭비된다. 두 문(look·do)을 모두 잰다.
        for (const which of ["do", "look"] as const) {
          const a = arena({ captureBytes: 2_000_000 });
          const r =
            which === "do"
              ? await a.doTool.handler({ ...press, frameId: "deadbeef" }, extra)
              : await a.look.handler({ region: { x: 0, y: 0, w: 10, h: 10 }, frameId: "deadbeef" }, extra);
          const t = textOf(r);
          out.push(
            assert(
              `★㉰-5(${which}) 전제 — 그림은 없는데 화면 id 는 유효하다`,
              !hasImage(r) && frameIdOf(r) !== null,
              `그림=${String(hasImage(r))} id=${String(frameIdOf(r))}`,
            ),
          );
          // ★★**쓸 수 있는 id 를 줬으면 «다시 보라» 고 하지 않는다** — 한 답에 다음 행동이
          //   둘이면 모델이 어느 쪽을 집을지 우리가 모른다(이 판이 닫으려던 바로 그 결함).
          out.push(
            assert(
              `★★㉰-5(${which}) 쓸 수 있는 id 를 준 답엔 **재관측 지시가 없다**`,
              !/`look` 으로 지금 화면|`look` 을 \*\*아무 인자 없이\*\*|직접 `look` 으로 보세요/.test(t),
              t.slice(0, 160),
            ),
          );
          out.push(
            assert(
              `★★㉰-5(${which}) 그 id 로 **조작이 실제로 나간다**(버리지 않는다)`,
              await (async () => {
                const before = a.log.posts.length;
                const d = await a.doTool.handler({ ...press, frameId: frameIdOf(r) ?? "x" }, extra);
                return a.log.posts.length > before && !/그 화면|모릅니다|쓸 수 없/.test(textOf(d));
              })(),
              t.slice(0, 140),
            ),
          );
        out.push(
          assert(
            "★★㉰-5 거절 문 — 다음 수 문장이 **한 곳(`nextAfterCapture`)에서 나온다**",
            saysNextFromOnePlace(r),
            textOf(r).slice(-140),
          ),
        );
        }
      }

      // ㉯ 화면 기하를 못 읽음 — **그림은 있는데 id 가 없다.** 그때 «아래 그림의 새 id»
      //    라고 하면 존재하지 않는 것을 가리킨다.
      {
        const a = arena({ noScreensFrom: 2 });
        const seen = await a.look.handler({}, extra);
        const id = frameIdOf(seen);
        const r = await a.doTool.handler({ ...press, frameId: id ?? "x" }, extra);
        const t = textOf(r);
        // ★**전제를 따로 세운다** (2026-09-21 2R). 종전엔 `frameIdOf(r) !== null || 문구` 였는데,
        //  그 첫 절이 «전제» 가 아니라 **면제**로 작동했다 — 제품이 id 를 (거짓으로) 말하기만
        //  하면 그 줄은 아무것도 안 쟀다. 전제가 깨지면 **그 사실이 빨개져야** 한다.
        out.push(
          assert(
            "★㉯ 전제 — 기하를 못 읽으면 **화면 id 가 안 나간다**(이게 깨지면 아래는 미검사다)",
            frameIdOf(r) === null,
            `id=${String(frameIdOf(r))}`,
          ),
        );
        out.push(
          assert(
            "★㉯ 그때는 **못 냈다고 말한다** — 없는 id 를 가리키지 않는다",
            /쓸 수 있는 화면 id 를 내지 못했습니다/.test(t) && !/아래 그림.{0,6}의 새 id/.test(t),
            t.slice(-150),
          ),
        );
        out.push(
          assert(
            "★★㉯ 사후 장면 — 다음 수 문장이 **한 곳(`nextAfterCapture`)에서 나온다**",
            saysNextFromOnePlace(r),
            textOf(r).slice(-140),
          ),
        );
      }
    }

    return out;
  },
};
