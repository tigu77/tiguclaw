/**
 * 회귀: **실제 포인터가 목표까지 미끄러지고, 표시의 중지 단추가 우리 클릭을 삼키지 않는가** (2026-11-24, ⑤ r4 —
 * 설계 `docs/decisions/2026-11-24-computer-use-indicator-esc.md` §11).
 *
 * ★배경 — 11-24 원격 시험에서 정태님이 «티구클로가 조작 중이라는 표시가 전혀 안 보였다». 원격 화면에는 표시가 없었고(창이
 *  캡처 제외), 포인터는 목표로 순간이동해 «어디로 가서 누르나» 를 눈으로 따라갈 수 없었다. 원격 Esc 는 앞 창에 갔는데 멈추지 않았다
 *  (HID 상태에 안 남음). 그래서: 포인터를 실제로 미끄러뜨리고(`glide`), 확실한 중지 길을 «표시의 단추» 로 두되 단추는 사람의 클릭을
 *  **언제나** 받고, 우리 클릭은 발사 전에 부모가 단추 자리를 보고 **비킨 것을 확인한 뒤에만** 보낸다(독립 검토 R1~R4 — 통과 모드는 사람의
 *  중지를 샜고, 실행부에서 파일로 단추를 추정하는 방식은 경합이 이어졌다).
 *
 * ★지키는 것:
 *  - 계획기: 클릭·스크롤·드래그 시작 **앞에** `glide`(목표 = 같은 변환 결과). 키·글자에는 없다.
 *  - 시한: `glide` 와 누름 유지가 열 예산에 들어간다(허용한 열이 시한에 죽지 않게).
 *  - mac 실행부(빈 연습 — 입력·클립보드·창 0): 먼 목표면 시간 상한(`GLIDE_MAX_MS`, 약 0.1초)만큼 이동 · 짧은 이동은 더 짧다 · 미끄러지는 도중 멈춤 요청이면
 *    그 단계는 «미실행». 실행부는 단추를 모른다 — 단추 회피는 부모(`clearPillFor`)가 발사 전에 하고 `computer-use-user-stop` #R4 가 잰다.
 *  - 도우미 원문: 창이 캡처에 보인다(`sharingType` 1) · 단추 클릭 = `{"stop":1}` · 단추에 통과 모드 없음 · 준비 줄·비킴 응답에 실제 자리 ·
 *    `app.run` + 16ms 타이머.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, loadPluginModule, skip, type Assertion, type RegressionCheck } from "./_framework.js";

type Rec = Record<string, unknown>;
type Ev = { t: string; x?: number; y?: number; [k: string]: unknown };
interface ControlModule {
  planSteps: (steps: readonly Rec[], frame: Rec, platform?: string) => { ok: true; events: Ev[] } | { ok: false; why: string };
  postTimeoutMs: (events: readonly Rec[], baseMs: number) => number;
  GLIDE_MAX_MS: number;
  GLIDE_MIN_MS: number;
  GLIDE_MS_PER_PX: number;
  GLIDE_TICK_MS: number;
  CLICK_HOLD_MS: number;
}
interface MacModule {
  POST_SCRIPT: string;
  INDICATOR_SCRIPT: string;
  dryPost: (events: Rec[], opts?: { stopFile?: string }) => Promise<Rec>;
}


export const check: RegressionCheck = {
  name: "computer-use-pointer-glide",
  guards:
    "포인터가 목표로 순간이동해 사람(원격 포함)이 «어디로 가서 누르나» 를 못 따라가던 것 · " +
    "표시의 중지 단추가 그 아래를 누르려던 우리 클릭을 «중지» 로 삼키는 것 · 사람의 중지 클릭이 단추를 통과해 아래 앱으로 새는 것 · " +
    "표시 창이 캡처에서 빠져 원격 화면에 안 보이던 것 · 데몬 자식에서 도우미 주기가 ~166ms 로 늘던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const ctl = await loadPluginModule<ControlModule>("../../../plugins/computer-use/src/control.ts");
    // 1600×900 그림 = 1600×900pt 화면(배율 1) — 좌표 변환이 항등이라 목표를 그대로 읽는다.
    const frame = {
      id: "f1",
      atMs: Date.now(),
      owner: "t1",
      front: "A:1",
      target: { kind: "screen" },
      geometry: { deliveredPx: { w: 1600, h: 900 }, capturedPx: { w: 1600, h: 900 }, originPt: { x: 0, y: 0 }, scale: 1 },
    };
    const kinds = (evs: readonly Ev[]): string => evs.filter((e) => e.t !== "mark" && e.t !== "guard").map((e) => e.t).join(">");

    // ── P1 계획기 — 포인터 동작 앞에만 glide ────────────────────────────────────────────
    {
      const click = ctl.planSteps([{ t: "click", x: 400, y: 300 }], frame);
      const scroll = ctl.planSteps([{ t: "scroll", x: 50, y: 60, dx: 0, dy: -120 }], frame);
      const drag = ctl.planSteps([{ t: "drag", path: [{ x: 10, y: 20 }, { x: 200, y: 20 }] }], frame);
      const keys = ctl.planSteps([{ t: "keydown", key: "shift" }, { t: "keyup", key: "shift" }, { t: "type", text: "가" }], frame);
      const at = (p: typeof click, k: number): Ev | undefined => (p.ok ? p.events.filter((e) => e.t !== "mark" && e.t !== "guard")[k] : undefined);
      const shape = {
        click: click.ok ? kinds(click.events) : click.why,
        clickSameTarget: at(click, 0)?.x === at(click, 1)?.x && at(click, 0)?.y === at(click, 1)?.y && at(click, 0)?.t === "glide",
        scroll: scroll.ok ? kinds(scroll.events) : scroll.why,
        drag: drag.ok ? kinds(drag.events).split(">").slice(0, 3).join(">") : drag.why,
        dragStart: at(drag, 0)?.x === at(drag, 2)?.x && at(drag, 0)?.y === at(drag, 2)?.y,
        keysNoGlide: keys.ok && !keys.events.some((e) => e.t === "glide"),
      };
      out.push(assert(
        "P1 계획기: 클릭·스크롤·드래그 시작 **앞에** glide(목표 = 같은 변환 결과) · 키·글자에는 없다",
        shape.click === "glide>mousemove>mousedown>mouseup" && shape.clickSameTarget && shape.scroll === "glide>mousemove>scroll" &&
          shape.drag === "glide>mousemove>mousedown" && shape.dragStart && shape.keysNoGlide,
        shape,
      ));
    }

    // ── P2 시한 — 미끄러짐·누름 유지가 예산에 든다 ───────────────────────────────────────
    {
      const base = ctl.postTimeoutMs([], 1000);
      const g = ctl.postTimeoutMs([{ t: "glide", x: 1, y: 1 }], 1000) - base;
      const d = ctl.postTimeoutMs([{ t: "mousedown", x: 1, y: 1, button: "left", count: 1 }], 1000) - base;
      out.push(assert(
        // ★박자 하나만이 아니라 Windows `Start-Sleep` 타이머 해상도(~15.6ms) 한 틱을 따로 덮어야 한다 — 마지막 쉼이 그만큼 늘 수 있다.
        "P2 시한: glide 하나가 미끄러짐 상한 + 박자 + Windows 타이머 한 틱(16ms) 이상을 · mousedown 이 누름 유지 이상을 예산에 더한다",
        g >= ctl.GLIDE_MAX_MS + ctl.GLIDE_TICK_MS + 16 && d >= ctl.CLICK_HOLD_MS,
        { glide: g, mousedown: d },
      ));
    }

    // ── P3·P4·P5 mac 실행부·도우미 ─────────────────────────────────────────────────────
    if (process.platform !== "darwin") {
      out.push(skip("P3·P4·P5 mac 실행부·도우미", `platform=${process.platform} — osascript 는 macOS 것이다`));
      return out;
    }
    const mac = await loadPluginModule<MacModule>("../../../plugins/computer-use/src/mac.ts");
    const dir = mkdtempSync(path.join(os.tmpdir(), "cu-glide-"));

    const FAR = 99_999;
    const FROM = { x: 300, y: 200 }; // 빈 연습 전용 고정 시작점(0 이 아닌 두 축)
    const clickAt = (x: number, y: number): Rec[] => [
      { t: "mark", i: 0 },
      { t: "glide", x, y },
      { t: "mousemove", x, y },
      { t: "mousedown", x, y, button: "left", count: 1 },
      { t: "mouseup", x, y, button: "left", count: 1 },
    ];

    // 빈 연습을 직접 띄워 모든 줄을 읽는다 — 실행부가 미끄러짐마다 내는 `{"glide":{d,ms}}`(빈 연습 전용: **실행부가 실제로 쓴** 거리와
    //  같은 단조시계로 잰 미끄러짐 시간)와 마지막 결과 줄. 다른 실행 간 시간 차·따로 읽은 커서에 기대지 않는다(R2).
    type GlideRow = { d: number; T: number; ms: number };
    const dryLines = (evs: Rec[], stopFile = ""): Promise<{ code: number | null; glides: GlideRow[]; last: Rec }> =>
      new Promise((resolve) => {
        const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", mac.POST_SCRIPT], {
          env: { ...process.env, TIGUCLAW_DRY: "1", TIGUCLAW_EVENTS: JSON.stringify(evs), TIGUCLAW_STOP_FILE: stopFile },
          stdio: ["ignore", "pipe", "ignore"],
        });
        let so = "";
        child.stdout.on("data", (b: Buffer) => { so += b.toString("utf8"); });
        const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        child.on("close", (code) => {
          clearTimeout(killer);
          const rows = so.trim().split("\n").map((l) => { try { return JSON.parse(l) as Rec; } catch { return {} as Rec; } });
          const glides = rows.map((x) => x["glide"] as GlideRow | undefined)
            .filter((g): g is GlideRow => g !== undefined && [g.d, g.T, g.ms].every(Number.isFinite) && g.ms >= 0);
          resolve({ code, glides, last: rows[rows.length - 1] ?? {} });
        });
      });
    // 기대 길이 — 실행부가 실제로 쓴 거리 d 로 계산한다(사람이 커서를 옮겨도 판정이 그 거리에 맞춰진다).
    const expectMs = (d: number): number => (d > 0 ? Math.min(ctl.GLIDE_MAX_MS, ctl.GLIDE_MIN_MS + d * ctl.GLIDE_MS_PER_PX) : 0);
    // 실측이 기대 이상이고, 마지막 박자 하나 + 부하 여유(40ms) 안에 끝났나. 실행부 상한을 180ms 로 늘리면 빨강이다.
    // ★실행부가 정한 목표 시간(T)이 식과 **정확히** 같아야 한다(같은 연산 순서) — 실측 구간만 보면 «100px 이하는 전부 50ms» 같은 식 오류가
    //  구간 안에 숨는다(R5).
    const onTime = (g: GlideRow | undefined): boolean =>
      g !== undefined && g.T === expectMs(g.d) && g.ms >= g.T - 1 && g.ms < g.T + ctl.GLIDE_TICK_MS + 40;

    // P3 — 먼 목표(화면 밖이어도 빈 연습은 안 쏜다): 이동 점을 여럿 찍고 mousemove·down·up 3개 · 길이 = min(상한, 최소 + 거리비) — 긴 이동 약 0.1초 ·
    //  중간(100px)·대각(50px)은 거리비대로 · 짧은 이동(2px)은 최소 근처. ★박자 수로 길이를 정하면 실행부 오버헤드가 쌓여 r4 «216ms» 가 실측 ~309ms 였다.
    // ★표본 시작점은 빈 연습 전용 `from`(고정 — 커서를 안 읽음)으로 준다. 0 이 아닌 두 축이라 «절대 목표를 오프셋으로 읽는» 오류도
    //  우연히 같아지지 않고, 사람이 커서를 옮겨도 거리가 정확하다(R3·R5). 목표는 실제 조작과 같은 절대좌표 분기를 지난다.
    {
      const r = await mac.dryPost(clickAt(FAR, FAR));
      const at = async (x: number, y: number): Promise<{ code: number | null; g: GlideRow | undefined }> => {
        const res = await dryLines([{ t: "mark", i: 0 }, { t: "glide", x, y, from: FROM }]);
        return { code: res.code, g: res.glides[0] };
      };
      const far = await at(FROM.x + FAR, FROM.y);
      const mid = await at(FROM.x + 100, FROM.y);
      const diag = await at(FROM.x + 30, FROM.y + 40);
      const near = await at(FROM.x + 2, FROM.y);
      // 표본 사이 **실측** 시간은 비교하지 않는다(별도 프로세스 — R4). 짧을수록 짧다는 것은 실행부가 낸 T 로 확인한다.
      out.push(assert(
        "P3 mac 빈 연습: 먼 목표면 이동 점을 여럿 찍고 누르기 3개 · 고정 시작점에서 실행부가 쓴 거리(먼·100px·대각 50px·2px 정확히)와 정한 시간 T = min(상한, 최소+거리비)(긴 이동 약 0.1초) · 실측이 T 대로 · 짧을수록 T 가 짧다",
        r["ok"] === true && typeof r["tried"] === "number" && (r["tried"] as number) >= 3 + 4 && r["stopped"] === false &&
          ctl.GLIDE_MAX_MS <= 120 && [far, mid, diag, near].every((x) => x.code === 0 && onTime(x.g)) &&
          far.g?.d === FAR && mid.g?.d === 100 && diag.g?.d === 50 && near.g?.d === 2 &&
          near.g.T < diag.g.T && diag.g.T < mid.g.T && mid.g.T < far.g.T && far.g.T === ctl.GLIDE_MAX_MS,
        { farTried: r["tried"], far: far.g, mid: mid.g, diag: diag.g, near: near.g },
      ));
    }

    // P4b·P4c — 멈춤 요청이 **이미 있을 때** 미끄러짐이 아무것도 쏘지 않고 끝나는가(시도 0 — 누르기 시도도 0). 단계 표시(mark)를 빼서
    //  단계 경계가 아니라 **미끄러짐 자신의** 확인이 잡게 한다(멈춘 단계 = 아직 없음 = -1). 시간에 기대지 않는 결정적 판정이다.
    //  P4b = 먼 목표: 반복 안 «도중» 확인 · P4c = 0 거리(반복 없음): «끝» 확인.
    {
      const stopFile = path.join(dir, "stop-pre");
      writeFileSync(stopFile, "");
      // 첫 원소만 고정 시작점(빈 연습 전용) — 멈춤이 맞으면 뒤 원소엔 닿지 않는다.
      const press = (x: number, y: number): Rec[] => [
        { t: "glide", x, y, from: FROM },
        { t: "mousemove", x, y },
        { t: "mousedown", x, y, button: "left", count: 1 },
        { t: "mouseup", x, y, button: "left", count: 1 },
      ];
      const far = await dryLines(press(FROM.x + FAR, FROM.y + FAR), stopFile);
      const zero = await dryLines(press(FROM.x, FROM.y), stopFile);
      // 이 열에서 멈출 수 있는 자리는 미끄러짐의 확인뿐이다(mark·wait·guard 없음). 시도 0 = 이동·누르기 발사 시도 모두 0.
      const stoppedHere = (x: { code: number | null; last: Rec }): boolean => {
        const s = x.last["stopped"] as Rec | null | undefined;
        return x.code === 0 && x.last["tried"] === 0 && s?.["stopped"] === -1 && s["why"] === "user-esc";
      };
      out.push(assert(
        "P4b·P4c mac 빈 연습: 멈춤 요청이 있으면 미끄러짐(먼 목표 = 반복 안 확인 · 실행부가 쓴 거리 정확히 0 = 반복 없이 끝 확인)이 시도 0 으로 끝나고 누르기도 시도 0",
        stoppedHere(far) && far.glides[0]?.d === Math.sqrt(FAR * FAR + FAR * FAR) && stoppedHere(zero) && zero.glides[0]?.d === 0,
        { far: { last: far.last, glide: far.glides[0] }, zero: { last: zero.last, glide: zero.glides[0] } },
      ));
    }

    // P4 — 단계 0 진입을 본 뒤 멈춤 파일 생성 → 미끄러지는 도중 끊긴다(누르기 시도 0)
    {
      const stopFile = path.join(dir, "stop-p4");
      const evs = clickAt(FAR, FAR);
      const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", mac.POST_SCRIPT], {
          env: { ...process.env, TIGUCLAW_DRY: "1", TIGUCLAW_EVENTS: JSON.stringify(evs), TIGUCLAW_STOP_FILE: stopFile },
          stdio: ["ignore", "pipe", "ignore"],
        });
        let so = "";
        child.stdout.on("data", (b: Buffer) => {
          so += b.toString("utf8");
          if (so.includes('{"step":0}') && !existsSync(stopFile)) writeFileSync(stopFile, "");
        });
        const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        child.on("close", (code) => { clearTimeout(killer); resolve({ code, out: so }); });
      });
      const last = (() => { try { return JSON.parse(r.out.trim().split("\n").pop() ?? "") as Rec; } catch { return {} as Rec; } })();
      const st = last["stopped"] as Rec | null | undefined;
      const tried = typeof last["tried"] === "number" ? (last["tried"] as number) : -1;
      out.push(assert(
        "P4 mac 빈 연습: 미끄러지는 도중 멈춤 요청 → 그 단계(0)에서 user-esc · 이동 시도는 상한보다 적고 누르기는 시도 0",
        // ★«도중» 인지 가른다 — 끝까지 미끄러진 뒤 끝 확인에서 멈춰도 stopped=0 이다. 먼 목표의 온전한 미끄러짐은 상한 시간/박자(=12.5)에
        //  가까운 점을 찍으므로(실측 ~11), 그 절반 미만이면 미끄러지는 도중에 끊긴 것이다(멈춤 파일은 단계 0 진입 직후에 생긴다).
        r.code === 0 && st?.["stopped"] === 0 && st["why"] === "user-esc" && tried >= 0 && tried < Math.floor(ctl.GLIDE_MAX_MS / ctl.GLIDE_TICK_MS / 2),
        { code: r.code, last },
      ));
    }

    // P5 — 도우미·실행부 원문 계약(창을 띄우는 실행은 회귀가 하지 않는다 — 사용자 화면을 안 건드린다)
    {
      const s = mac.INDICATOR_SCRIPT;
      const p = mac.POST_SCRIPT;
      const shape = {
        // 화면 공유·원격 접속이 쓰는 캡처에 창이 보인다(None=0 이면 원격에 안 보였다).
        sharedReadOnly: /p\.setSharingType\(1\);/.test(s) && !/setSharingType\(0\)/.test(s),
        buttonEmitsStop: /'mouseDown:': \{ types: \['void', \['id'\]\], implementation: function \(ev\) \{ emit\(\{stop: 1\}\); \} \}/.test(s) &&
          /'acceptsFirstMouse:'/.test(s) && /tag\.setIgnoresMouseEvents\(false\);/.test(s),
        // 단추는 사람 클릭을 언제나 받는다 — 통과 모드가 없다(사람의 중지가 새면 안 된다).
        neverPassThrough: (s.match(/tag\.setIgnoresMouseEvents\(/g) ?? []).length === 1,
        // 준비 줄은 단추를 띄운 **뒤**, 실제 자리와 함께 — 부모는 이 줄 전엔 누름을 보내지 않는다.
        readyAfterFront: s.indexOf("tag.orderFrontRegardless") >= 0 && s.indexOf("tag.orderFrontRegardless") < s.indexOf("emit({ready: 1, pill: pillRect()});"),
        // 비킴 요청(`;` 로 끝난 새 내용)을 받으면 옮긴 **뒤 실제 자리**를 요청과 함께 응답한다 · 자리 파일은 없다(출력 줄로만).
        moveAnswered: /if \(mv !== lastMove && mv\.charAt\(mv\.length - 1\) === ';'\) \{ lastMove = mv; atTop = !atTop; tag\.setFrameOrigin\([^;]*\); emit\(\{pill: pillRect\(\), req: mv\}\); \}/.test(s) &&
          !/TIGUCLAW_INDICATOR_PILL|writePill|writeNone/.test(s),
        // 클릭을 받으려면 `app.run`(손으로 꺼내는 루프엔 마우스 이벤트가 안 왔다) · 감시는 허용 오차 0 의 16ms 타이머 —
        //  날짜 시한 대기(`runUntilDate`·`+0.02s`)는 데몬 자식에서 ~166ms 로 늘었다.
        appRunTimer: /app\.run;/.test(s) && /timerWithTimeIntervalTargetSelectorUserInfoRepeats\(0\.016, ticker, 'tick:'/.test(s) && /timer\.setTolerance\(0\);/.test(s) &&
          !/runUntilDate|dateWithTimeIntervalSinceNow|nextEventMatchingMask/.test(s),
        // 번쩍임은 숫자(두께)만 — 임시 CGColor 를 넘기면 PAC 예외로 커널이 도우미를 죽였다.
        flashNoColorObject: /setBorderWidth\(fl \? 8 : 3\)/.test(s) && !/setBackgroundColor\(\(fl/.test(s),
        flashOnPress: /Number\(\$\.NSEvent\.pressedMouseButtons\) !== 0/.test(s),
        // 실행부는 단추를 모른다(판단은 부모 한 곳) · 미끄러짐 끝(마지막 박자 뒤)에도 멈춤을 본다 · 누른 뒤만 유지.
        execUnawareOfPill: !/PILL|clearOfPill|readPill|MOVEF/.test(p),
        glideFinalStop: p.includes("if (!gstop && stopAsked()) { gstop = true; }"),
        // 길이는 경과 시간이 정하고(박자 수 아님) 곡선은 ease-out 3차(목표 직전 감속)다.
        glideTimedEaseOut: p.includes("gu = Math.min(1, (PI.systemUptime - g0) * 1000 / gT); var gs = 1 - (1 - gu) * (1 - gu) * (1 - gu);") &&
          // 감속 값이 실제로 쏘는 좌표 **두 축**에 쓰인다(계산만 하고 선형으로 쏘면 빨강).
          p.includes("post($.CGEventCreateMouseEvent($(), 5, {x: c0.x + gdx * gs, y: c0.y + gdy * gs}, 0));"),
        clickHold: /pause\(e\.t === 'mousedown' \? CLICK_HOLD : 0\.012\);/.test(p),
      };
      out.push(assert(
        "P5 mac 원문: 표시 창이 캡처에 보인다(sharingType 1) · 단추 클릭 = {\"stop\":1}(첫 클릭도) · 단추는 통과 모드 없음 · 준비 줄은 단추를 띄운 뒤 실제 자리와 함께 · 비킴 요청에 옮긴 뒤 실제 자리 응답 · 도우미는 app.run + 16ms 타이머 · 번쩍임은 두께로 · 실행부는 단추를 모르고 미끄러짐 끝에도 멈춤을 본다 · 미끄러짐은 경과 시간 + ease-out",
        Object.values(shape).every(Boolean),
        shape,
      ));
    }
    rmSync(dir, { recursive: true, force: true });
    return out;
  },
};
