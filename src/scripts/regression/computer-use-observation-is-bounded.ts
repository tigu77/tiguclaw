/**
 * 회귀: **화면 관측이 매달리지도, 쌓이지도, 사용자 프레임을 잃지도 않는다** (2026-09-16).
 *
 * ★배경: 권한 프롬프트는 **호출 프로세스를 막는다**(실측: System Events 조회가 AppleEvent
 *  타임아웃까지 반환 안 했다). 그리고 MCP `callTool` 천장은 **11분**이라, 플러그인이 자기
 *  시한을 안 걸면 턴이 11분 묶인다 — 외부 MCP 8분 hang 과 같은 모양이다.
 *
 * ★이 검사는 **순수부를 실행한다.** 캡처 자체(자식 프로세스)는 여기서 안 돌린다 —
 *  권한·화면 상태에 따라 결과가 갈려 결정적이지 않고, 무엇보다 **회귀가 사용자 화면을
 *  찍으면 안 된다**(픽스처에 실데이터를 넣지 않는다, principle-check Q7).
 */
import {
  assert,
  loadPluginModule,
  type Assertion,
  type RegressionCheck,
} from "./_framework.js";

/**
 * ★플러그인 소스를 **리터럴로 import 하지 않는다.** 정적이든 `await import("…")` 이든 tsc 는
 *  둘 다 따라가서 `npm run build`(rootDir=`src`)를 `TS6059` 로 깬다 — 실제로 이 검사를 처음
 *  쓸 때 그렇게 깨졌고 소스 트리에 `.js`·`.d.ts` 가 뱉어졌다. 지정자를 **계산**하는
 *  `loadPluginModule` 이 그 자리다. 타입은 여기서 **쓸 모양만** 적는다 —
 *  `typeof import("…")` 을 쓰면 그 파일이 다시 프로그램에 들어와 원래 문제로 돌아간다.
 */
type CaptureTarget =
  | { kind: "screen" }
  | { kind: "display"; index: number }
  | { kind: "region"; x: number; y: number; width: number; height: number };
interface ObserveModule {
  captureArgs: (t: CaptureTarget, out: string) => string[];
  frameName: (threadKey: string, at: Date, nonce?: string) => string;
  framesToDelete: (
    files: readonly { name: string; mtimeMs: number }[],
    now: number,
    opts?: { keepPerThread?: number; maxAgeMs?: number },
  ) => string[];
  observationMeta: (o: {
    target: CaptureTarget;
    at: Date;
    bytes: number;
    savedPath: string;
    longEdge: number;
    platform: string;
    clippedFrom?: { x: number; y: number; width: number; height: number };
    spansScreens?: number;
  }) => string;
  checkTarget: (
    target: CaptureTarget,
    screens: readonly { x: number; y: number; w: number; h: number }[] | undefined,
  ) =>
    | {
        ok: true;
        target: CaptureTarget;
        clippedFrom?: { x: number; y: number; width: number; height: number };
        spans: number;
      }
    | { ok: false; region: { x: number; y: number; width: number; height: number } };
  preflightMessage: (
    probe: { ok: true } | { ok: false; reason: "timeout" | "failed"; detail?: string },
    platform: string,
  ) => string | null;
  clipRegionToScreens: (
    region: { x: number; y: number; width: number; height: number },
    screens: readonly { x: number; y: number; w: number; h: number }[],
  ) =>
    | {
        ok: true;
        region: { x: number; y: number; width: number; height: number };
        clipped: boolean;
        spans: number;
      }
    | { ok: false };
  offscreenMessage: (
    region: { x: number; y: number; width: number; height: number },
    screens: readonly { x: number; y: number; w: number; h: number }[],
  ) => string;
  winCaptureEnv: (
    target: CaptureTarget | { kind: "probe" },
    outPath: string,
    opts?: { longEdge?: number; quality?: number },
  ) => Record<string, string>;
  FRAME_KEEP_PER_THREAD: number;
  FRAME_MAX_BYTES: number;
  describeLongEdge: (longEdge: number) => string;
  imagePointToScreen: (
    img: { x: number; y: number },
    g: {
      deliveredPx: { w: number; h: number };
      capturedPx: { w: number; h: number };
      originPt: { x: number; y: number };
      scale: number;
    },
  ) => { x: number; y: number } | null;
  deriveScale: (probePt: number, probePx: number) => number | null;
  userIsActive: (idleSeconds: number | null, windowMs?: number) => boolean;
  leaseDecision: (
    current: { owner: string; lastTouchedMs: number } | null,
    asker: string,
    nowMs: number,
    idleMs?: number,
  ) => { ok: true; next: { owner: string; lastTouchedMs: number } } | { ok: false; heldBy: string };
}

export const check: RegressionCheck = {
  name: "computer-use-observation-is-bounded",
  guards:
    "화면 관측이 권한 대화상자에 매달려 턴을 MCP 천장(11분)까지 묶는 것 · 프레임이 디스크에 무한 누적되는 것 · 활발한 스레드가 조용한 스레드의 몫을 먹는 것 · 관측 한계를 모델에게 안 알리는 것 · **Windows 에서 경로가 PowerShell 코드로 섞이거나 맥 전용 처방이 나가는 것** · **화면 밖 좌표가 «성공한 관측» 으로 나가는 것**(실기 확인) · 검사가 **호스트 OS 에 따라 갈리는 것**",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const {
      captureArgs,
      frameName,
      framesToDelete,
      observationMeta,
      preflightMessage,
      winCaptureEnv,
      clipRegionToScreens,
      checkTarget,
      offscreenMessage,
      FRAME_KEEP_PER_THREAD,
      FRAME_MAX_BYTES,
      describeLongEdge,
      imagePointToScreen,
      deriveScale,
      userIsActive,
      leaseDecision,
    } = await loadPluginModule<ObserveModule>(
      "../../../plugins/computer-use/src/observe.ts",
    );

    // ── ① 대화식 옵션은 **절대** 안 쓴다 — 사용자 클릭을 기다리며 멈춘다 ──────────
    const interactive = ["-i", "-w", "-W", "-s"];
    const allArgs = [
      captureArgs({ kind: "screen" }, "/tmp/a.png"),
      captureArgs({ kind: "display", index: 2 }, "/tmp/a.png"),
      captureArgs({ kind: "region", x: 1, y: 2, width: 3, height: 4 }, "/tmp/a.png"),
    ];
    out.push(
      assert(
        "캡처 인자에 대화식 옵션이 없다(있으면 데몬이 클릭을 기다리며 멈춘다)",
        allArgs.every((a) => !a.some((x) => interactive.includes(x))),
        JSON.stringify(allArgs),
      ),
    );
    out.push(
      assert(
        "캡처 인자에 무음(-x)이 항상 붙는다",
        allArgs.every((a) => a.includes("-x")),
        JSON.stringify(allArgs.map((a) => a[0])),
      ),
    );
    out.push(
      assert(
        "영역 인자가 좌표를 그대로 싣는다",
        captureArgs({ kind: "region", x: 1, y: 2, width: 3, height: 4 }, "/tmp/a.png").includes(
          "-R1,2,3,4",
        ),
        JSON.stringify(captureArgs({ kind: "region", x: 1, y: 2, width: 3, height: 4 }, "/tmp/a.png")),
      ),
    );

    // ── ② 권한이 없으면 **말하고 끝낸다** — 조용히 실패하지 않는다 ────────────────
    const timeoutMsg = preflightMessage({ ok: false, reason: "timeout" }, "darwin");
    out.push(
      assert(
        "시한 초과면 «권한 대화상자» 와 켜는 법을 알린다",
        timeoutMsg !== null &&
          timeoutMsg.includes("화면 기록") &&
          timeoutMsg.includes("재시작"),
        JSON.stringify(timeoutMsg?.slice(0, 80)),
      ),
    );
    out.push(
      assert(
        "권한이 있으면 경고를 만들지 않는다(정상 경로에 잡음 0)",
        preflightMessage({ ok: true }, "darwin") === null &&
          preflightMessage({ ok: true }, "win32") === null,
        String(preflightMessage({ ok: true }, "darwin")),
      ),
    );

    //  ★실측된 «권한 없음» 의 얼굴을 안내로 바꾼다 — 원시 오류를 사용자에게 흘리지 않는다.
    const denied = preflightMessage({
      ok: false,
      reason: "failed",
      detail:
        "Command failed: /usr/sbin/screencapture -x -R0,0,1,1 /var/folders/3_/xxx/T/probe.png\ncould not create image from rect\n",
    }, "darwin");
    out.push(
      assert(
        "권한 없음은 «화면 기록 권한» 안내로 바뀌고 원시 명령줄이 안 샌다",
        denied !== null &&
          denied.includes("화면 기록 권한이 없습니다") &&
          !denied.includes("/var/folders") &&
          !denied.includes("screencapture -x"),
        JSON.stringify(denied?.slice(0, 90)),
      ),
    );

    //  ★**권한 신호가 없으면 권한 이야기를 하지 않는다** — 잘못된 디스플레이 번호 같은
    //   평범한 오류가 권한 문제로 오진되던 것. 그리고 그 분기로 원시 명령줄이 새던 것.
    const other = preflightMessage({
      ok: false,
      reason: "failed",
      detail:
        "Command failed: /usr/sbin/screencapture -x -D99 /var/folders/3_/xxx/T/f.png\ninvalid display specified\n",
    }, "darwin");
    out.push(
      assert(
        "권한과 무관한 실패는 «화면 기록» 을 안 권하고, **사유는 싣되** 원시 명령줄은 안 샌다",
        // ★«사유를 싣는다» 를 같이 재지 않으면, 아무것도 안 싣는 퇴화 상태가 통과한다
        //  (실제로 그랬다 — `execFile` 메시지가 개행으로 끝나 사유가 늘 비었다).
        other !== null &&
          other.includes("invalid display specified") &&
          !other.includes("화면 기록") &&
          !other.includes("/var/folders") &&
          !other.includes("screencapture -x"),
        JSON.stringify(other),
      ),
    );

    // ── ③ 관측 결과가 «확인된 제한» 을 싣는다 (요청서 §6) ────────────────────────
    //  ★macOS 는 권한이 없어도 오류 대신 바탕화면만 담긴 그림을 줄 수 있다. 우리는 그걸
    //   픽셀로 안 가리기로 했으므로(요청서가 기각한 가정), **모른다는 사실을 말해야** 한다.
    const meta = observationMeta({
      target: { kind: "region", x: 0, y: 0, width: 800, height: 600 },
      at: new Date("2026-09-16T00:00:00Z"),
      bytes: 123_456,
      savedPath: "/tmp/x.png",
      longEdge: 1600,
      platform: "darwin",
    });
    out.push(
      assert(
        "관측 메타에 시각·영역·저장 경로·확인된 제한이 전부 있다",
        meta.includes("2026-09-16T00:00:00") &&
          meta.includes("800×600") &&
          meta.includes("/tmp/x.png") &&
          meta.includes("확인된 제한"),
        meta.slice(0, 120),
      ),
    );

    // ── ④ 프레임 정리 — **스레드별**로 센다 ──────────────────────────────────────
    //  ★전체 개수로 자르면 활발한 스레드가 조용한 스레드의 몫을 먹는다.
    //   `store/events.ts` 가 전체 건수 프루닝에서 겪고 고친 바로 그 오염이다.
    const now = Date.parse("2026-09-16T00:00:00Z");
    const busy = Array.from({ length: 30 }, (_, i) => ({
      name: frameName("dashboard:busy", new Date(now - i * 1000)),
      mtimeMs: now - i * 1000,
    }));
    const quiet = [
      { name: frameName("tg:quiet", new Date(now - 5_000)), mtimeMs: now - 5_000 },
    ];
    const doomed = new Set(framesToDelete([...busy, ...quiet], now));
    out.push(
      assert(
        "활발한 스레드 30장 중 창(10)만 남고, 조용한 스레드 1장은 살아남는다",
        doomed.size === 30 - FRAME_KEEP_PER_THREAD &&
          !doomed.has(quiet[0]?.name ?? ""),
        `지울 것 ${doomed.size}장 · 조용한 스레드 생존 ${!doomed.has(quiet[0]?.name ?? "")}`,
      ),
    );
    out.push(
      assert(
        "남는 것은 **최신** 쪽이다(오래된 것부터 지운다)",
        !doomed.has(busy[0]?.name ?? "") && doomed.has(busy[29]?.name ?? ""),
        `최신 생존=${!doomed.has(busy[0]?.name ?? "")} 최고참 삭제=${doomed.has(busy[29]?.name ?? "")}`,
      ),
    );

    //  ★**확장자가 섞여도 같은 스레드로 센다** — 변환이 실패하면 원본 `.png` 가 남는다.
    //   확장자를 안 떼면 같은 스레드의 `.jpg` 와 `.png` 가 **다른 스레드로** 세어져
    //   창이 조용히 두 배가 된다.
    const mixed = [
      ...Array.from({ length: 8 }, (_, i) => ({
        name: frameName("dashboard:mix", new Date(now - i * 1000)),
        mtimeMs: now - i * 1000,
      })),
      ...Array.from({ length: 8 }, (_, i) => ({
        name: frameName("dashboard:mix", new Date(now - (i + 8) * 1000)).replace(/\.jpg$/, ".png"),
        mtimeMs: now - (i + 8) * 1000,
      })),
    ];
    out.push(
      assert(
        "같은 스레드의 jpg·png 16장은 한 창으로 세어 6장이 지워진다(확장자로 안 갈린다)",
        framesToDelete(mixed, now).length === 16 - FRAME_KEEP_PER_THREAD,
        `지울 것 ${framesToDelete(mixed, now).length}장 (창=${FRAME_KEEP_PER_THREAD}, 총 16장)`,
      ),
    );

    // ── ★동시 관측이 서로를 덮지 않는다 (2026-09-16 아스트라 P2 와 같은 부류) ──────
    //  매니저와 서브가 **같은 스레드에서 같은 밀리초에** 관측하면 시각만으로는 이름이
    //  충돌해 한쪽이 다른 쪽 파일을 덮는다. 그리고 nonce 는 **시각 쪽에** 붙어야 한다 —
    //  스레드 부분에 붙이면 정리 규칙이 스레드를 되읽지 못해 창이 갈린다.
    const sameMs = new Date(now);
    const n1 = frameName("dashboard:x", sameMs, "aaaa1111");
    const n2 = frameName("dashboard:x", sameMs, "bbbb2222");
    out.push(
      assert(
        "같은 스레드·같은 밀리초의 두 관측이 서로 다른 파일이 된다",
        n1 !== n2,
        `${n1} / ${n2}`,
      ),
    );
    out.push(
      assert(
        "그래도 둘은 **같은 스레드**로 세어진다(nonce 가 스레드 판정을 안 깬다)",
        framesToDelete(
          [
            ...Array.from({ length: 12 }, (_, i) => ({
              name: frameName("dashboard:x", new Date(now - i * 1000), `n${i}`),
              mtimeMs: now - i * 1000,
            })),
          ],
          now,
        ).length === 12 - FRAME_KEEP_PER_THREAD,
        `지울 것 ${framesToDelete([...Array.from({ length: 12 }, (_, i) => ({ name: frameName("dashboard:x", new Date(now - i * 1000), `n${i}`), mtimeMs: now - i * 1000 }))], now).length}장 (창=${FRAME_KEEP_PER_THREAD}, 총 12장)`,
      ),
    );

    // ── ⑤ 나이 상한 — 스레드 수와 무관하게 오래된 것은 지운다 ────────────────────
    const old = [
      { name: frameName("tg:one", new Date(now - 40 * 24 * 3600_000)), mtimeMs: now - 40 * 24 * 3600_000 },
    ];
    out.push(
      assert(
        "40일 된 프레임은 한 장뿐이어도 지운다(나이 상한)",
        framesToDelete(old, now).length === 1,
        `지울 것 ${framesToDelete(old, now).length}장`,
      ),
    );

    // ── ⑥ 파일 이름이 스레드를 되읽을 수 있게 담는다 ─────────────────────────────
    //  ★이게 깨지면 ④의 «스레드별» 이 조용히 «전체» 가 된다.
    const a = frameName("dashboard:abc", new Date(now));
    const b = frameName("tg:999", new Date(now));
    out.push(
      assert(
        "서로 다른 스레드는 이름으로 구분된다",
        a !== b && a.includes("dashboard_abc") && b.includes("tg_999"),
        `${a} / ${b}`,
      ),
    );
    // ── ★payload 바이트 상한 · «못 줄였다» 번역 (2026-09-16 적대 검토 P) ──────────
    out.push(
      assert(
        "긴 변 -1(줄이기 실패)을 모델에게 «-1px» 로 보여주지 않는다",
        describeLongEdge(-1).includes("실패") &&
          !describeLongEdge(-1).includes("-1") &&
          describeLongEdge(1600) === "긴 변 1600px",
        `${describeLongEdge(-1)} / ${describeLongEdge(1600)}`,
      ),
    );
    out.push(
      assert(
        "바이트 상한이 정상 JPEG(실측 0.23MB)보다 크고 원본 PNG(실측 3.8MB)보다 작다",
        FRAME_MAX_BYTES > 240_000 && FRAME_MAX_BYTES < 3_800_000,
        `상한 ${FRAME_MAX_BYTES.toLocaleString()}B`,
      ),
    );
    out.push(
      assert(
        "관측 메타가 줄이기 실패를 문장으로 싣는다(숫자만 찍지 않는다)",
        observationMeta({
          target: { kind: "screen" },
          at: new Date(now),
          bytes: 3_800_000,
          savedPath: "/tmp/x.png",
          longEdge: -1,
          platform: "darwin",
        }).includes("원본 그대로"),
        observationMeta({
          target: { kind: "screen" },
          at: new Date(now),
          bytes: 3_800_000,
          savedPath: "/tmp/x.png",
          longEdge: -1,
          platform: "darwin",
        }).split("\n")[2] ?? "",
      ),
    );

    // ── ★2단계 준비: 좌표 변환 · 사용자 충돌 · 리스 ──────────────────────────────
    //  ★여기가 틀리면 **엉뚱한 데를 누른다.** 관측과 달리 클릭은 되돌릴 수 없다.
    //  실측 기하(이 기계): 캡처 3456×2234px · 배율 2 · 전달 긴 변 1600px.
    const geo = {
      deliveredPx: { w: 1600, h: 1034 },
      capturedPx: { w: 3456, h: 2234 },
      originPt: { x: 0, y: 0 },
      scale: 2,
    };
    const mid = imagePointToScreen({ x: 800, y: 517 }, geo);
    out.push(
      assert(
        "이미지 중앙이 화면 중앙(포인트)으로 간다 — 축소 배율과 레티나 배율을 둘 다 푼다",
        mid !== null && Math.abs(mid.x - 864) <= 1 && Math.abs(mid.y - 558) <= 2,
        JSON.stringify(mid),
      ),
    );
    out.push(
      assert(
        "이미지 밖 좌표는 **거절**한다(조용히 가장자리로 뭉개지 않는다)",
        imagePointToScreen({ x: 1601, y: 0 }, geo) === null &&
          imagePointToScreen({ x: -1, y: 0 }, geo) === null,
        `밖=${JSON.stringify(imagePointToScreen({ x: 1601, y: 0 }, geo))}`,
      ),
    );
    out.push(
      assert(
        "말이 안 되는 기하면 좌표를 지어내지 않는다(0으로 나누기·음수 배율)",
        imagePointToScreen({ x: 1, y: 1 }, { ...geo, scale: 0 }) === null &&
          imagePointToScreen({ x: 1, y: 1 }, { ...geo, deliveredPx: { w: 0, h: 0 } }) === null,
        `배율0=${JSON.stringify(imagePointToScreen({ x: 1, y: 1 }, { ...geo, scale: 0 }))} · 크기0=${JSON.stringify(imagePointToScreen({ x: 1, y: 1 }, { ...geo, deliveredPx: { w: 0, h: 0 } }))}`,
      ),
    );
    out.push(
      assert(
        "배율을 박지 않고 탐침에서 유도한다(외부 모니터는 1배)",
        deriveScale(100, 200) === 2 && deriveScale(100, 100) === 1 && deriveScale(0, 200) === null,
        `${deriveScale(100, 200)} · ${deriveScale(100, 100)} · ${deriveScale(0, 200)}`,
      ),
    );
    out.push(
      assert(
        "★사용자 활동을 **모르면 «쓰는 중»** 으로 본다(판정 불가를 빈손으로 읽으면 사람 손 위에서 누른다)",
        userIsActive(null) === true &&
          userIsActive(Number.NaN) === true &&
          userIsActive(0.5) === true &&
          userIsActive(10) === false,
        `null=${userIsActive(null)} NaN=${userIsActive(Number.NaN)} 0.5s=${userIsActive(0.5)} 10s=${userIsActive(10)}`,
      ),
    );
    const t = 1_000_000;
    const held = leaseDecision({ owner: "A", lastTouchedMs: t }, "B", t + 1_000);
    out.push(
      assert(
        "리스: 남이 쥐고 있으면 **즉시 실패**한다(큐가 아니다 — 큐는 숨은 대기다)",
        held.ok === false && held.heldBy === "A",
        JSON.stringify(held),
      ),
    );
    out.push(
      assert(
        "리스: 같은 소유자는 계속 쓰고, 유휴 시한이 지나면 남이 가져간다(죽은 소유자가 영원히 붙들지 않는다)",
        leaseDecision({ owner: "A", lastTouchedMs: t }, "A", t + 1_000).ok === true &&
          leaseDecision({ owner: "A", lastTouchedMs: t }, "B", t + 60_000).ok === true,
        `같은소유자 ${leaseDecision({ owner: "A", lastTouchedMs: t }, "A", t + 1_000).ok} · 만료후 ${leaseDecision({ owner: "A", lastTouchedMs: t }, "B", t + 60_000).ok}`,
      ),
    );

    // ── ★Windows 실행부 (2026-09-17) ────────────────────────────────────────────
    //  ★**경로가 코드가 되면 안 된다.** mac 은 `execFile` argv 라 안전하지만 PowerShell 은
    //   `-Command` 를 다시 파싱한다. 파일 이름엔 `threadKey` 가 들어가고 그건 바깥에서 온다.
    //   그래서 변하는 값은 **전부 env** 로 가야 하고, 그 계약을 여기서 잡는다.
    const evil = "C:\\tmp\\a'; Remove-Item C:\\ -Recurse; '.jpg";
    const env = winCaptureEnv({ kind: "region", x: 1, y: 2, width: 3, height: 4 }, evil);
    out.push(
      assert(
        "★Windows: 경로·좌표가 **전부 env 로** 간다(스크립트에 끼워 넣을 자리가 없다)",
        env.TIGUCLAW_OUT === evil &&
          env.TIGUCLAW_MODE === "region" &&
          env.TIGUCLAW_X === "1" &&
          env.TIGUCLAW_W === "3" &&
          env.TIGUCLAW_LONG_EDGE !== undefined &&
          env.TIGUCLAW_QUALITY !== undefined,
        JSON.stringify(env),
      ),
    );
    out.push(
      assert(
        "Windows: 탐침은 줄이기를 끄고(longEdge=0) 모드로 구분된다",
        winCaptureEnv({ kind: "probe" }, "/tmp/p.jpg", { longEdge: 0 }).TIGUCLAW_MODE === "probe" &&
          winCaptureEnv({ kind: "probe" }, "/tmp/p.jpg", { longEdge: 0 }).TIGUCLAW_LONG_EDGE === "0" &&
          winCaptureEnv({ kind: "display", index: 2 }, "/tmp/p.jpg").TIGUCLAW_DISPLAY === "2",
        JSON.stringify(winCaptureEnv({ kind: "probe" }, "/tmp/p.jpg", { longEdge: 0 })),
      ),
    );

    //  ★**플랫폼마다 «할 일» 이 다르다.** 맥 문구를 Windows 에 내보내면 사용자는 있지도
    //   않은 설정 화면을 찾으러 간다 — 틀린 안내는 없느니만 못하다.
    const winSession = preflightMessage(
      { ok: false, reason: "failed", detail: "no-desktop: no screens in this session" },
      "win32",
    );
    out.push(
      assert(
        "★Windows: 세션 없음(Session 0)에 **무엇을 바꿔야 하는지**를 말한다(맥 권한 화면을 시키지 않는다)",
        winSession !== null &&
          winSession.includes("세션") &&
          !winSession.includes("화면 기록") &&
          !winSession.includes("시스템 설정"),
        (winSession ?? "").slice(0, 80),
      ),
    );
    const macPerm = preflightMessage(
      { ok: false, reason: "failed", detail: "could not create image from display" },
      "darwin",
    );
    out.push(
      assert(
        "mac 쪽 처방은 그대로다(플랫폼 분기가 기존 경로를 안 바꿨다)",
        macPerm !== null && macPerm.includes("화면 기록"),
        (macPerm ?? "").slice(0, 60),
      ),
    );

    //  ★★경로 유출 — 종전엔 `/` 만 걸러서 **Windows 경로가 그대로 샜다**. 사용자에게 줄 것은
    //   «왜» 지 «어떻게 불렀나» 가 아니다(맥에서 두 번 막은 유출이 형제 플랫폼에서 다시 열렸다).
    const leak = preflightMessage(
      {
        ok: false,
        reason: "failed",
        detail: "Exception calling Save with 3 argument(s): C:\\Users\\tigu7\\AppData\\Local\\Temp\\x.jpg",
      },
      "win32",
    );
    out.push(
      assert(
        "★Windows: 실패 사유에 **경로가 안 실린다**(역슬래시 경로도 걸린다)",
        leak !== null && !leak.includes("C:\\") && !leak.includes("Users"),
        (leak ?? "").slice(0, 100),
      ),
    );

    //  ★«확인된 제한» 도 플랫폼마다 다르다 — Windows 엔 «화면 기록 권한» 이 없다.
    const winMeta = observationMeta({
      target: { kind: "screen" },
      at: new Date("2026-09-17T00:00:00Z"),
      bytes: 200_000,
      savedPath: "C:\\tmp\\x.jpg",
      longEdge: 1600,
      platform: "win32",
    });
    out.push(
      assert(
        "★Windows 관측 메타: 맥 전용 권한 문구 대신 **잠금 화면·보호 콘텐츠**를 말하고, 한 디스플레이 한계는 공통이다",
        winMeta.includes("확인된 제한") &&
          !winMeta.includes("화면 기록 권한") &&
          winMeta.includes("잠금 화면") &&
          winMeta.includes("한 디스플레이"),
        winMeta.split("\n").pop() ?? "",
      ),
    );

    // ── ★화면 밖 영역 (2026-09-17, 회사돌쇠 실기 P2) ────────────────────────────
    //  실측: `{x:100000,y:100000,32×24}` 가 **성공한 관측**으로 돌아왔다(643바이트 JPEG).
    //  Windows `CopyFromScreen` 은 화면 밖을 검게 채울 뿐 실패하지 않는다. 그림의 검은색으로
    //  판정하는 게 아니라 **아는 화면 배치로** 가른다.
    //  배치: 실기와 같게 — 주 (0,0,2560,1440) · 보조 (2560,0,2560,1440).
    const screens = [
      { x: 0, y: 0, w: 2560, h: 1440 },
      { x: 2560, y: 0, w: 2560, h: 1440 },
    ];
    const inside = clipRegionToScreens({ x: 100, y: 100, width: 32, height: 24 }, screens);
    out.push(
      assert(
        "화면 안쪽 영역은 그대로 통과한다(자르지 않는다)",
        inside.ok && !inside.clipped && inside.region.width === 32 && inside.region.x === 100,
        JSON.stringify(inside),
      ),
    );
    const far = clipRegionToScreens({ x: 100_000, y: 100_000, width: 32, height: 24 }, screens);
    out.push(
      assert(
        "★화면 밖 영역은 **거절**한다(존재하지 않는 좌표가 정상 관측으로 나가던 것)",
        !far.ok,
        JSON.stringify(far),
      ),
    );
    const edge = clipRegionToScreens({ x: -20, y: 0, width: 32, height: 24 }, screens);
    out.push(
      assert(
        "가장자리에 걸친 영역은 **화면 안쪽만** 남긴다(요청 −20..12 → 실제 0..12)",
        edge.ok && edge.clipped && edge.region.x === 0 && edge.region.width === 12,
        JSON.stringify(edge),
      ),
    );
    //  ★외접 사각형으로 재면 여기가 통과한다 — 두 화면이 어긋나게 놓이면 **사이에 빈 공간**이
    //   생기고, 그 좌표는 bounding box 안에 있지만 어느 화면에도 없다.
    const gapScreens = [
      { x: 0, y: 0, w: 1000, h: 1000 },
      { x: 2000, y: 0, w: 1000, h: 1000 },
    ];
    const gap = clipRegionToScreens({ x: 1200, y: 100, width: 50, height: 50 }, gapScreens);
    out.push(
      assert(
        "★모니터 **사이 빈 공간**도 거절한다(외접 사각형이 아니라 화면마다 따로 본다)",
        !gap.ok,
        JSON.stringify(gap),
      ),
    );
    const negative = clipRegionToScreens({ x: -1900, y: 50, width: 100, height: 100 }, [
      { x: -1920, y: 0, w: 1920, h: 1080 },
      { x: 0, y: 0, w: 2560, h: 1440 },
    ]);
    out.push(
      assert(
        "**음수 원점** 모니터(왼쪽 배치)의 정상 영역은 통과한다 — 음수라고 밖이 아니다",
        negative.ok && !negative.clipped && negative.region.x === -1900,
        JSON.stringify(negative),
      ),
    );
    out.push(
      assert(
        "화면 배치를 **모르면 막지 않는다**(관측은 가역 — 모름을 거절로 읽지 않는다)",
        clipRegionToScreens({ x: 100_000, y: 100_000, width: 32, height: 24 }, []).ok,
        JSON.stringify(clipRegionToScreens({ x: 1, y: 1, width: 2, height: 2 }, [])),
      ),
    );
    const offMsg = offscreenMessage({ x: 100_000, y: 100_000, width: 32, height: 24 }, screens);
    out.push(
      assert(
        "거절 메시지가 **화면 배치를 알려준다**(모델이 다시 찍을 수 있어야 한다)",
        offMsg.includes("2560×1440") && offMsg.includes("@(2560,0)") && offMsg.includes("겹치지 않"),
        offMsg.split("\n").pop() ?? "",
      ),
    );
    const clippedMeta = observationMeta({
      target: { kind: "region", x: 0, y: 0, width: 12, height: 24 },
      at: new Date("2026-09-17T00:00:00Z"),
      bytes: 1_000,
      savedPath: "C:\\tmp\\x.jpg",
      longEdge: 24,
      platform: "win32",
      clippedFrom: { x: -20, y: 0, width: 32, height: 24 },
    });
    out.push(
      assert(
        "★잘렸으면 **잘렸다고 말한다**(요청과 실제가 둘 다 보인다 — 조용히 자르면 좌표가 어긋난다)",
        clippedMeta.includes("32×24 @(-20,0)") && clippedMeta.includes("12×24 @(0,0)"),
        clippedMeta.split("\n")[1] ?? "",
      ),
    );

    // ── ★단일 관문 (2026-09-17, 회사돌쇠 재검토) ────────────────────────────────
    //  ★재검토가 짚은 것: 검사가 도구 핸들러에만 있어서 백엔드를 **직접 부르면** 화면 밖
    //   좌표가 그대로 성공했다. 지금은 `checkTarget` 하나가 판정하고, 실행부는 그걸 통과한
    //   값만 **타입으로** 받는다. 여기서는 그 관문의 «판단» 을 잰다(타입은 tsc 가 잰다).
    const full = checkTarget({ kind: "screen" }, screens);
    const disp = checkTarget({ kind: "display", index: 2 }, screens);
    out.push(
      assert(
        "관문: 전체 화면·디스플레이는 그대로 통과한다(좌표가 없다 — 번호는 실행부가 판정)",
        full.ok && full.target.kind === "screen" && disp.ok && disp.target.kind === "display",
        `${JSON.stringify(full)} · ${JSON.stringify(disp)}`,
      ),
    );
    const gateOff = checkTarget(
      { kind: "region", x: 100_000, y: 100_000, width: 32, height: 24 },
      screens,
    );
    out.push(
      assert(
        "★관문: 화면 밖 영역은 실행부에 **닿지 못한다**",
        !gateOff.ok && gateOff.region.x === 100_000,
        JSON.stringify(gateOff),
      ),
    );
    const gateClip = checkTarget({ kind: "region", x: -20, y: 0, width: 32, height: 24 }, screens);
    out.push(
      assert(
        "관문: 걸친 영역은 잘린 대상 + 원래 요청을 같이 돌려준다",
        gateClip.ok &&
          gateClip.target.kind === "region" &&
          gateClip.target.width === 12 &&
          gateClip.clippedFrom?.width === 32,
        JSON.stringify(gateClip),
      ),
    );
    out.push(
      assert(
        "관문: 화면 배치를 모르면(mac) 영역을 그대로 통과시킨다",
        checkTarget({ kind: "region", x: 100_000, y: 100_000, width: 4, height: 4 }, undefined).ok,
        JSON.stringify(
          checkTarget({ kind: "region", x: 100_000, y: 100_000, width: 4, height: 4 }, undefined),
        ),
      ),
    );

    //  ★여러 화면에 걸친 영역 — **거절이 아니라 말한다.** 두 화면에 걸친 사각형은 가상
    //   데스크톱에서 실제로 그 모양이고, 사이 빈 공간이 검은 것도 사실이다(잠금 화면이 검게
    //   나오는 것과 같은 부류라 «확인된 제한» 에 속한다).
    const across = clipRegionToScreens({ x: 2500, y: 100, width: 200, height: 100 }, screens);
    out.push(
      assert(
        "두 화면에 걸친 영역은 **걸친 화면 수**를 센다",
        across.ok && across.spans === 2,
        JSON.stringify(across),
      ),
    );
    const spanMeta = observationMeta({
      target: { kind: "region", x: 2500, y: 100, width: 200, height: 100 },
      at: new Date("2026-09-17T00:00:00Z"),
      bytes: 2_000,
      savedPath: "C:\\tmp\\x.jpg",
      longEdge: 200,
      platform: "win32",
      spansScreens: 2,
    });
    out.push(
      assert(
        "★여러 화면에 걸치면 **사이 빈 공간이 검다**고 메타가 말한다(거절하지 않는다)",
        spanMeta.includes("화면 2개에 걸쳐") && spanMeta.includes("빈 공간"),
        spanMeta.split("\n")[1] ?? "",
      ),
    );
    const oneScreenMeta = observationMeta({
      target: { kind: "region", x: 10, y: 10, width: 20, height: 20 },
      at: new Date("2026-09-17T00:00:00Z"),
      bytes: 100,
      savedPath: "/tmp/x.jpg",
      longEdge: 20,
      platform: "win32",
      spansScreens: 1,
    });
    out.push(
      assert(
        "한 화면 안이면 그 고지를 **안 붙인다**(정상 경로에 잡음 0)",
        !oneScreenMeta.includes("걸쳐"),
        oneScreenMeta.split("\n")[1] ?? "",
      ),
    );

    return out;
  },
};
