/**
 * **화면 관측의 «판단» 부분 — 전부 순수 함수다** (2026-09-16).
 *
 * ★여기에 `spawn` 이 없는 것이 요점이다. 이 플러그인의 판단(무엇을 찍을지 인자를 어떻게
 *  만드나 · 권한이 없을 때 뭐라고 할까 · 어떤 프레임을 지울까 · 모델에게 무엇을 알릴까)을
 *  불순한 자리에 두면 **검사하려고 데몬을 띄워야 한다** — 그건 자리가 잘못됐다는 신호다
 *  ([[feedback_simple_composable_no_duplication]] — "검사가 껄끄러우면 코드가 잘못 놓인 것").
 *  회귀는 이 파일을 **실행해서** 판정한다.
 *
 * ★1단계는 **읽기 전용**이다 — 클릭·입력이 없다. 그리고 **특정 창을 안 찍는다**(창 열거는
 *  손쉬운 사용 권한이나 네이티브 호출이 필요해서 1단계 밖이다). 전체 화면·특정
 *  디스플레이·영역까지다.
 */

/** 무엇을 찍을지 — 1단계의 전부. 창(window)은 없다. */
export type CaptureTarget =
  | { kind: "screen" }
  | { kind: "display"; index: number }
  | { kind: "region"; x: number; y: number; width: number; height: number };

/**
 * mac `screencapture` 인자 조립 — **순수**. 실행은 `mac.ts` 가 한다.
 *
 * ★`-x`(무음)는 항상 붙인다. 비서가 화면을 찍을 때마다 셔터음이 나면 그 자체가 방해다.
 * ★대화식 옵션(`-i`·`-w`·`-W`)은 **절대 쓰지 않는다** — 사용자 클릭을 기다리며 멈춘다.
 *  데몬엔 그 클릭을 할 사람이 없다.
 */
export const captureArgs = (target: CaptureTarget, outPath: string): string[] => {
  const base = ["-x"];
  switch (target.kind) {
    case "screen":
      return [...base, "-m", outPath]; // 주 디스플레이 1장
    case "display":
      return [...base, `-D${target.index}`, outPath];
    case "region":
      return [
        ...base,
        `-R${target.x},${target.y},${target.width},${target.height}`,
        outPath,
      ];
  }
};

/** 관측 결과 파일 이름 — 매니저·서브에이전트가 같이 쓰므로 스레드와 시각이 들어간다. */
export const frameName = (threadKey: string, at: Date, nonce?: string): string => {
  const safe = threadKey.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60);
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  // ★**같은 밀리초에 겹칠 수 있다** (2026-09-16, 아스트라 P2 와 같은 부류). 매니저와
  //  서브가 같은 스레드에서 동시에 관측하면 시각만으로는 이름이 충돌해 한쪽이 다른 쪽
  //  파일을 덮는다. nonce 는 **시각 쪽에** 붙인다 — 스레드 부분에 붙이면 정리 규칙이
  //  스레드를 되읽지 못해 창이 갈린다.
  const tag = nonce === undefined || nonce === "" ? "" : `-${nonce}`;
  return `${stamp}${tag}__${safe}.jpg`;
};

/**
 * **권한이 없을 때 모델에게 할 말** — 순수.
 *
 * ★탐지 결과를 «검은 화면인가» 로 판정하지 **않는다**. 요청서가 명시적으로 기각한 가정이다
 *  ("검은 화면이면 캡처 실패다" 는 채택하지 않는다). 우리가 아는 것은 **종료 코드·파일
 *  존재·시간 초과**뿐이고, 그 밖은 «모른다» 라고 말한다.
 */
export const preflightMessage = (
  probe: { ok: true } | { ok: false; reason: "timeout" | "failed"; detail?: string },
): string | null => {
  if (probe.ok) return null;
  if (probe.reason === "timeout") {
    return (
      "화면을 찍지 못했습니다 — 권한 대화상자가 떠 있을 수 있습니다.\n" +
      "시스템 설정 → 개인정보 보호 및 보안 → 화면 기록 에서 이 앱을 켜 주세요. " +
      "켠 뒤에는 데몬을 한 번 재시작해야 반영됩니다."
    );
  }
  // ★**권한 없음의 실제 얼굴**(2026-09-16 실측): `screencapture` 는 종료코드 1과
  //  `could not create image from display|rect` 를 낸다. 이때 원시 오류를 그대로 실으면
  //  임시 경로와 명령줄이 사용자 눈에 가는데, 그건 **정보가 아니라 잡음**이다 —
  //  사용자가 할 일은 하나(권한 켜기)뿐이다.
  if (/could not create image/i.test(probe.detail ?? "")) {
    return (
      "화면을 찍지 못했습니다 — **화면 기록 권한이 없습니다.**\n" +
      "시스템 설정 → 개인정보 보호 및 보안 → 화면 기록 에서 켜 주세요. " +
      "켠 뒤에는 데몬을 한 번 재시작해야 반영됩니다."
    );
  }
  // ★**권한 신호가 없으면 권한 이야기를 하지 않는다** (2026-09-16 적대 검토 P).
  //  종전엔 모든 실패가 «화면 기록 을 확인해 주세요» 로 끝나서, 잘못된 디스플레이 번호 같은
  //  평범한 오류가 **권한 문제로 오진**됐다. 게다가 원시 오류를 120자 실었는데 그 안에
  //  `Command failed: /usr/sbin/screencapture -x -D99 /var/folders/…` 가 **통째로 들어온다**
  //  (접두부만 47자) — 바로 위 분기가 막은 유출이 형제 분기로 새고 있었다.
  // ★**빈 줄을 빼고** 마지막 의미 있는 줄을 쓴다. `execFile` 의 메시지는
  //  `Command failed: <명령줄>\n<stderr>\n` 이라 그냥 `pop()` 하면 **항상 빈 문자열**이 되고,
  //  그러면 사유가 **한 번도 안 실린다**(겉보기엔 «유출 없음» 이라 검사도 통과한다).
  const lines = (probe.detail ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const why = lines[lines.length - 1] ?? "";
  // 경로·명령줄이 섞인 줄은 버린다 — 사용자에게 줄 것은 «왜» 지 «어떻게 불렀나» 가 아니다.
  const clean = why !== "" && !why.includes("/") ? ` — ${why.slice(0, 120)}` : "";
  return `화면을 찍지 못했습니다${clean}. 대상(디스플레이 번호·영역)이 맞는지 확인해 주세요.`;
};

/**
 * 관측 결과에 **반드시** 따라가는 사실들 (요청서 §6).
 *
 * ★«확인된 제한» 을 같이 싣는 이유: macOS 는 권한이 없어도 **오류 대신 바탕화면만 담긴
 *  그림**을 줄 수 있다. 우리는 그걸 픽셀로 가려내지 않기로 했으므로(위 주석), **모른다는
 *  사실 자체를 모델에게 말한다.** 안 그러면 모델이 "창이 하나도 없네" 를 사실로 읽는다.
 */
export const observationMeta = (o: {
  target: CaptureTarget;
  at: Date;
  bytes: number;
  savedPath: string;
  longEdge: number;
}): string => {
  const what =
    o.target.kind === "screen"
      ? "주 디스플레이 전체"
      : o.target.kind === "display"
        ? `디스플레이 ${o.target.index}`
        : `영역 ${o.target.width}×${o.target.height} @(${o.target.x},${o.target.y})`;
  return [
    `관측: ${what}`,
    `시각: ${o.at.toISOString()}`,
    `크기: ${describeLongEdge(o.longEdge)} · ${o.bytes.toLocaleString()}바이트`,
    `저장: ${o.savedPath}`,
    "확인된 제한: (1) 화면 기록 권한이 없으면 macOS 가 오류 대신 바탕화면만 담긴 그림을 줄 수 있습니다. " +
      "보이는 것이 기대와 다르면 권한부터 확인하세요 — 그림만으로는 구분할 수 없습니다. " +
      "(2) 이 관측은 **한 디스플레이**만 담습니다. 모니터가 여럿이면 나머지는 여기 없습니다 — " +
      "«화면에 없다» 를 «존재하지 않는다» 로 읽지 마세요.",
  ].join("\n");
};

/**
 * **어떤 프레임을 지울까** — 순수. 파일 목록을 받아 지울 목록을 돌려준다.
 *
 * ★프레임은 **기록이 아니라 워킹셋**이다. 석 달 전 화면의 픽셀은 값이 거의 0이고,
 *  «무엇을 봤나» 의 기록은 텍스트(관측 메타·도구 결과)가 이미 갖고 있다. 그러니 바운드는
 *  «콜드 레코드는 안 지운다» 위반이 아니라 `events` 와 같은 부류다
 *  ([[project_hotpath_bound_preserve_record]]).
 *
 * ★★**두 상한은 잠정값이다** (2026-09-16, 정태님 승인). 실사용 로그로 재서 확정한다 —
 *  직감으로 박은 숫자를 «정해진 것» 으로 읽지 마라. 재는 법: `[screen]` 로그의 `지움=` 이
 *  매 관측마다 찍히면 상한이 너무 빡빡한 것이고, 몇 주간 0이면 디스크만 먹는 것이다.
 */
export const FRAME_KEEP_PER_THREAD = 10; // 잠정
export const FRAME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 잠정 — 7일

export const framesToDelete = (
  files: readonly { name: string; mtimeMs: number }[],
  now: number,
  opts?: { keepPerThread?: number; maxAgeMs?: number },
): string[] => {
  const keep = opts?.keepPerThread ?? FRAME_KEEP_PER_THREAD;
  const maxAge = opts?.maxAgeMs ?? FRAME_MAX_AGE_MS;
  const doomed = new Set<string>();

  // ① 나이 — 스레드와 무관하게 오래된 것은 지운다.
  for (const f of files) {
    if (now - f.mtimeMs > maxAge) doomed.add(f.name);
  }

  // ② 스레드별 최근 N장 — **스레드마다 따로 센다.** 전체 개수로 자르면 활발한 스레드가
  //    조용한 스레드의 몫을 먹는다(`store/events.ts` 가 전체 건수 프루닝에서 겪고 고친 것).
  const byThread = new Map<string, { name: string; mtimeMs: number }[]>();
  for (const f of files) {
    // ★확장자를 떼고 센다 — 안 떼면 같은 스레드의 `.jpg` 와 `.png`(변환 실패분)가
    //  **다른 스레드로** 세어져 창이 두 배가 된다.
    const tail = f.name.includes("__") ? f.name.slice(f.name.indexOf("__") + 2) : "";
    const thread = tail.replace(/\.(jpg|png)(\.raw\.png)?$/, "");
    const list = byThread.get(thread) ?? [];
    list.push(f);
    byThread.set(thread, list);
  }
  for (const list of byThread.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs); // 최신 먼저
    for (const f of list.slice(keep)) doomed.add(f.name);
  }
  return [...doomed];
};

/**
 * 모델에 싣는 그림의 긴 변 상한(px) — 잠정. 텍스트가 읽히는 선에서 payload 를 묶는다.
 *
 * ★**해상도를 줄이는 것보다 압축이 낫다**(2026-09-16 실측, 같은 화면 3456×2234 기준):
 *
 *     PNG  1600   1.32MB      JPEG 1600 q80   0.23MB   ← 5.7배, 작은 한글 UI 까지 읽힘
 *     PNG  1200   0.77MB      JPEG 1600 q60   0.16MB   ← 이득 0.07MB 뿐
 *                             JPEG 1200 q80   0.14MB   ← 작은 글자가 실제로 뭉갠다
 *
 *  그래서 **1600 을 유지하고 압축으로 줄인다.** 1200 으로 내리면 아낀 것보다 잃는 게 크다.
 */
export const FRAME_LONG_EDGE = 1600;

/**
 * JPEG 품질 — 잠정.
 *
 * ★**손실 압축이다.** 창·버튼·글자 판정에는 영향이 없는 것을 실측으로 확인했지만,
 *  아주 미세한 1px 선이나 옅은 색 경계는 뭉갤 수 있다. «픽셀 단위로 비교» 같은 작업이
 *  실제로 생기면 그때 무손실 선택지를 연다 — 지금은 그런 소비처가 **없다**.
 */
export const FRAME_QUALITY = 80;

/**
 * **모델에 싣는 그림의 바이트 상한** — 잠정 (2026-09-16 적대 검토 P).
 *
 * ★`FRAME_LONG_EDGE` 는 **픽셀** 상한이지 바이트 상한이 아니다. 줄이기·변환이 실패하면
 *  원본 PNG 가 그대로 실리는데, 실측 전체 화면 원본은 **3.8MB**(base64 ≈5.1MB)다 —
 *  2026-09-15 에 «이미지가 요청에 쌓인다» 를 고친 그 payload 바운드가 **이 경로로 샌다.**
 * ★상한을 넘으면 **그림을 안 싣는다**(텍스트로 사실을 말하고 파일 경로를 준다).
 *  큰 걸 억지로 싣느니 **없이 말하는 게** 낫다 — 모델은 다시 찍으면 된다.
 * ★정상 JPEG 은 실측 0.23MB 라 이 상한(1.5MB)에 한참 못 미친다. 걸리는 것은
 *  **변환이 실패한 경우**뿐이다.
 */
export const FRAME_MAX_BYTES = 1_500_000;

/** 긴 변을 «못 줄였다»(-1)를 사람이 읽는 말로 — 모델에게 `-1px` 를 보여주지 않는다. */
export const describeLongEdge = (longEdge: number): string =>
  longEdge > 0 ? `긴 변 ${longEdge}px` : "크기 줄이기 실패(원본 그대로)";

// ─── 2단계: 조작 ─────────────────────────────────────────────────────────────

/**
 * **관측 이미지의 좌표 → 화면 좌표** — 순수 (2026-09-16).
 *
 * ★여기가 틀리면 **엉뚱한 데를 누른다.** 그래서 순수 함수로 두고 검사가 실행한다.
 *
 * ★단위가 **셋**이다(실측, 이 기계 3456×2234 레티나):
 *
 *     모델이 보는 이미지   sips -Z 로 줄인 뒤의 **픽셀**   (긴 변 1600)
 *     캡처 원본            screencapture 가 낸 **픽셀**    (3456×2234)
 *     화면                 클릭이 쓰는 **포인트**          (1728×1117)
 *
 *  `screencapture -R` 은 **포인트**를 받는데 출력은 **픽셀**이다 — 실측:
 *  `-R0,0,100,100` → 200×200px, `-R0,0,200,150` → 400×300px. 즉 배율 2.
 *
 * ★**배율을 박지 않는다.** 외부 모니터는 1배고, 「더 넓게」 모드는 또 다르다. 호출부가
 *  탐침으로 **유도한 값**을 넘긴다(`probeScale`).
 * ★반올림은 **마지막에 한 번**만 — 중간에 하면 축소 배율(2.16)이 곱해져 오차가 커진다.
 */
export interface FrameGeometry {
  /** 모델에게 준 이미지의 픽셀 크기(줄인 뒤). */
  deliveredPx: { w: number; h: number };
  /** `screencapture` 가 낸 원본 픽셀 크기. */
  capturedPx: { w: number; h: number };
  /** 이 캡처가 화면의 어디서 시작하나 — **포인트**. 전체 화면이면 {0,0}. */
  originPt: { x: number; y: number };
  /** 포인트→픽셀 배율(실측으로 유도한 값). 레티나 2, 외부 모니터 1. */
  scale: number;
};

export const imagePointToScreen = (
  img: { x: number; y: number },
  g: FrameGeometry,
): { x: number; y: number } | null => {
  const { deliveredPx: d, capturedPx: c, originPt: o, scale } = g;
  // ★**말이 안 되는 기하는 좌표를 지어내지 않는다.** 0으로 나누거나 음수 배율이면
  //  «모른다» 를 돌려준다 — 틀린 좌표로 클릭하는 것보다 안 누르는 게 낫다.
  if (!(d.w > 0 && d.h > 0 && c.w > 0 && c.h > 0 && scale > 0)) return null;
  if (!(Number.isFinite(img.x) && Number.isFinite(img.y))) return null;
  // ★**이미지 밖은 거절한다.** 모델이 0~1 정규화 좌표를 줬거나 옛 관측의 좌표를 그대로
  //  쓰면 여기서 걸린다 — 조용히 가장자리로 뭉개면 엉뚱한 걸 누른다.
  if (img.x < 0 || img.y < 0 || img.x > d.w || img.y > d.h) return null;
  const px = { x: (img.x * c.w) / d.w, y: (img.y * c.h) / d.h };
  return {
    x: Math.round(o.x + px.x / scale),
    y: Math.round(o.y + px.y / scale),
  };
};

/**
 * 포인트→픽셀 배율을 **탐침 결과에서 유도한다** — 순수.
 * `screencapture -R0,0,N,N`(포인트) 의 산출 이미지가 M 픽셀이면 배율은 M/N 이다.
 */
export const deriveScale = (probePt: number, probePx: number): number | null => {
  if (!(probePt > 0 && probePx > 0)) return null;
  const s = probePx / probePt;
  // 실제로 쓰이는 값은 1 또는 2(간혹 소수 배율). 터무니없으면 «모른다».
  return s >= 0.5 && s <= 4 ? s : null;
};

/**
 * **사용자가 방금 그 기계를 썼나** — 순수 판정 (설계 §3-4).
 *
 * ★관측과 달리 **클릭은 되돌릴 수 없다.** 그래서 «되돌릴 수 있거나 최악이 사소하거나» 라는
 *  자동 조치 기준을 조작은 통과하지 못한다 — 사람이 쓰는 중이면 **안 누른다.**
 * ★★**2초는 안 잰 값이다**(잠정). 짧으면 충돌하고 길면 비서가 굶는다. 실사용 로그의
 *  «user active» 빈도로 재서 확정한다 — 직감으로 박은 숫자를 «정해진 것» 으로 읽지 마라.
 */
export const USER_ACTIVE_WINDOW_MS = 2_000;

export const userIsActive = (idleSeconds: number | null, windowMs = USER_ACTIVE_WINDOW_MS): boolean =>
  // ★**모르면 «쓰는 중» 으로 본다.** 판정 불가를 «비어 있다» 로 읽으면 사람 손 위에서 클릭한다.
  idleSeconds === null || !Number.isFinite(idleSeconds) || idleSeconds * 1000 < windowMs;

/**
 * **데스크톱 리스** — 커서가 하나라는 물리 (설계 §3-3). 순수 상태 기계.
 *
 * ★**관측은 리스가 필요 없다**(읽기는 안 겹친다). 조작만 잡는다.
 * ★**큐가 아니라 즉시 실패**다. 큐는 숨은 대기라, 서브의 턴이 도구 호출 하나에 매달린다
 *  (외부 MCP 8분 hang 과 같은 모양). 오류 결과는 정상 스티어링 입력이고, 매니저는 자기
 *  서브를 이미 순서 세우는 주체다.
 * ★해제는 셋이다: 소유자가 놓거나 · 소유 턴이 끝났다는 이벤트 · **유휴 시한**.
 *  `callTool` 에 signal 이 없어(MCP 한계) 유휴가 마지막 그물이다 — 없으면 한 번 잡고
 *  죽은 소유자가 데스크톱을 영원히 붙든다.
 * ★★**시한도 잠정값이다.**
 */
export const LEASE_IDLE_MS = 60_000;

export interface LeaseState {
  owner: string;
  lastTouchedMs: number;
}

export const leaseDecision = (
  current: LeaseState | null,
  asker: string,
  nowMs: number,
  idleMs = LEASE_IDLE_MS,
): { ok: true; next: LeaseState } | { ok: false; heldBy: string } => {
  const expired = current !== null && nowMs - current.lastTouchedMs >= idleMs;
  if (current === null || expired || current.owner === asker) {
    return { ok: true, next: { owner: asker, lastTouchedMs: nowMs } };
  }
  return { ok: false, heldBy: current.owner };
};

/** 리스를 못 잡았을 때 모델에게 할 말 — 기다리라고 하지 않는다(큐가 아니다). */
export const busyMessage = (heldBy: string): string =>
  `데스크톱이 사용 중입니다 (${heldBy} 가 쓰는 중). 기다리지 말고 그 작업이 끝난 뒤 다시 시도하거나, ` +
  `매니저라면 자식 작업의 순서를 세워 주세요.`;
