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

/**
 * **화면 하나의 사각형** — 실행부가 탐침에서 읽어 온다(Windows 는 `Screen.AllScreens`).
 *
 * ★mac 은 이 정보를 **못 준다**(설계 §6-C: 원점·배율을 알 수단이 없다). 그래서 아래 판정은
 *  «화면을 아는 플랫폼에서만» 돈다 — 모르는 쪽을 막지 않는다(관측은 가역이다).
 */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * 포인트→픽셀 배율. 없으면 1.
   *
   * ★맥은 좌표가 **포인트**이고 캡처 산출이 **픽셀**이라 둘이 갈린다(레티나 2). Windows 는
   *  자식이 DPI-aware 라 **픽셀=픽셀**이므로 1이다 — 그래서 옵션이다.
   */
  scale?: number;
}

export type RegionClip =
  | {
      ok: true;
      region: { x: number; y: number; width: number; height: number };
      clipped: boolean;
      /** 이 영역이 걸친 화면 수. 2 이상이면 **사이 빈 공간이 검게** 담길 수 있다. */
      spans: number;
    }
  | { ok: false };

/**
 * **요청한 영역을 실제 화면에 맞춘다** — 순수 (2026-09-17, 회사돌쇠 실기 P2).
 *
 * ★실측으로 잡힌 결함: `{x:100000, y:100000, 32×24}` 가 **성공한 관측으로** 돌아왔다
 *  (643바이트 JPEG). Windows `CopyFromScreen` 은 화면 밖을 **검게 채울 뿐 실패하지 않는다.**
 *  «검은 그림이면 실패» 로 판정하자는 게 아니다 — 진짜 검은 화면은 정상 관측이다. 문제는
 *  **존재하지 않는 좌표를 정상 관측과 구분하지 않은 것**이다. 화면 사각형을 알고 있는데
 *  안 쓴 것이라 «모르는 것» 도 아니었다.
 *
 * ★**외접 사각형으로 재지 않는다.** 가상 화면 전체의 bounding box 로만 보면 **모니터 사이
 *  빈 공간**이 통과한다(두 모니터가 어긋나게 놓이면 생긴다). 그래서 **각 화면과 따로**
 *  교집합을 본다 — 하나도 안 겹치면 거절이다.
 *
 * ★**일부만 걸친 것은 자른다**(거절이 아니라). 이유: mac `screencapture -R` 은 화면 밖을
 *  **원래 잘라서** 준다 — 즉 자르기는 새로 들이는 동작이 아니라 **이미 일어나는 일**이고,
 *  지금 없는 건 «잘렸다고 말하는 것» 뿐이다. 자른 사실과 실제 범위는 관측 메타가 싣는다
 *  (조용히 자르면 요청 좌표와 그림이 어긋나 2단계 기하가 깨진다 — 그게 리뷰의 우려였고,
 *  «명시» 가 그 조건을 푼다).
 */
export const clipRegionToScreens = (
  region: { x: number; y: number; width: number; height: number },
  screens: readonly ScreenRect[],
): RegionClip => {
  // ★**화면을 모르면 막지 않는다.** 관측은 가역이라 «모름» 을 «거절» 로 읽을 이유가 없다
  //  (조작이면 반대다 — 그쪽은 모르면 안 누른다).
  if (screens.length === 0) return { ok: true, region, clipped: false, spans: 0 };
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let spans = 0;
  for (const s of screens) {
    const ix = Math.max(region.x, s.x);
    const iy = Math.max(region.y, s.y);
    const ir = Math.min(region.x + region.width, s.x + s.w);
    const ib = Math.min(region.y + region.height, s.y + s.h);
    if (ir <= ix || ib <= iy) continue; // 이 화면과는 안 겹친다
    spans += 1;
    left = Math.min(left, ix);
    top = Math.min(top, iy);
    right = Math.max(right, ir);
    bottom = Math.max(bottom, ib);
  }
  if (right <= left || bottom <= top) return { ok: false };
  const clipped =
    left !== region.x ||
    top !== region.y ||
    right - left !== region.width ||
    bottom - top !== region.height;
  return {
    ok: true,
    region: { x: left, y: top, width: right - left, height: bottom - top },
    clipped,
    spans,
  };
};

/** 어느 화면과도 안 겹칠 때 모델에게 할 말 — **배치를 알려준다**(다시 찍을 수 있게). */
export const offscreenMessage = (
  region: { x: number; y: number; width: number; height: number },
  screens: readonly ScreenRect[],
): string =>
  `요청한 영역 ${region.width}×${region.height} @(${region.x},${region.y}) 은 **어느 화면과도 겹치지 않습니다.** ` +
  `화면을 벗어난 좌표는 검게 나올 뿐이라 찍지 않았습니다.\n` +
  `화면 배치: ${screens
    .map((s, i) => `${String(i + 1)}번 ${s.w}×${s.h} @(${s.x},${s.y})`)
    .join(" · ")}`;

/**
 * **검증을 통과한 캡처 대상** — 실행부는 이것만 받는다 (2026-09-17, 회사돌쇠 재검토).
 *
 * ★재검토가 짚은 것: 영역 검사가 `index.ts` 의 도구 핸들러에만 있어서 `win.capture` 를
 *  **직접 부르면** 화면 밖 좌표가 그대로 성공했다. 지금은 호출부가 하나라 사용자에게 새지
 *  않지만, 둘째 호출부가 생기면 같은 결함이 **조용히 되살아난다.**
 *
 * ★그래서 «백엔드는 검증된 영역만 받는다» 를 **주석이 아니라 타입으로** 둔다. 검사를 양쪽에
 *  복붙하는 것(=같은 판단이 두 곳)도, 말로만 약속하는 것(=손으로 지키는 계약)도 아니다 —
 *  [[feedback_simple_composable_no_duplication]] 의 «이음매에서 새면 린트 말고 이음매를
 *  없애라». `checkTarget()` 을 통과하지 않은 값은 **컴파일이 안 된다.**
 *
 * ★백엔드 안에서 다시 검사하지 않는 이유: mac 은 화면 배치를 **알 수 없고**(§6-C), 알려면
 *  자식 프로세스가 하나 더 든다. 아는 쪽(호출부)이 한 번 재고 그 결과를 타입에 싣는 게 맞다.
 */
declare const checked: unique symbol;
export type CheckedTarget = CaptureTarget & { readonly [checked]: true };

export type TargetCheck =
  | { ok: true; target: CheckedTarget; clippedFrom?: { x: number; y: number; width: number; height: number }; spans: number }
  | { ok: false; region: { x: number; y: number; width: number; height: number } };

/**
 * **캡처 전 단일 관문** — 여기를 지난 것만 실행부에 들어간다. 순수.
 *
 * 전체 화면·디스플레이는 통과시킨다(좌표가 없다 — 디스플레이 번호는 실행부가 실제 개수로
 * 판정하고 그 오류가 개수를 알려준다). 영역만 화면 배치와 대조한다.
 */
export const checkTarget = (
  target: CaptureTarget,
  screens: readonly ScreenRect[] | undefined,
): TargetCheck => {
  if (target.kind !== "region" || screens === undefined) {
    return { ok: true, target: target as CheckedTarget, spans: 0 };
  }
  const want = { x: target.x, y: target.y, width: target.width, height: target.height };
  const fit = clipRegionToScreens(want, screens);
  if (!fit.ok) return { ok: false, region: want };
  return {
    ok: true,
    target: { kind: "region", ...fit.region } as CheckedTarget,
    ...(fit.clipped ? { clippedFrom: want } : {}),
    spans: fit.spans,
  };
};

/**
 * **그림 좌표의 영역 → 화면 좌표의 영역** — 순수 (2026-09-17, 돌쇠 실측).
 *
 * ★★**좌표계가 둘로 섞여 있었다.** 클릭은 «그림 픽셀» 인데 `look` 의 `region` 은
 *  «화면 좌표» 였다. 이 기계는 둘의 차이가 8%뿐이라(그림 1600 vs 화면 1728pt) 대충 맞아
 *  보였지만, **축소율이 큰 화면에서는 관측 그림에서 읽은 좌표로 영역을 잡으면 엉뚱한 데가
 *  잡히고, 그 그림 위에서 누르면 조용히 딴 데를 클릭한다.** 되돌릴 수 없는 도구라 실제
 *  사고 경로다.
 * ★고침은 «설명에 적기» 가 아니라 **하나로 만들기**다 — 모델이 보는 좌표는 **언제나 그림
 *  픽셀** 이고, 화면 좌표는 플러그인 안에서만 산다.
 */
export const imageRectToScreen = (
  rect: { x: number; y: number; width: number; height: number },
  g: FrameGeometry,
): { x: number; y: number; width: number; height: number } | null => {
  const tl = imagePointToScreen({ x: rect.x, y: rect.y }, g);
  // ★오른쪽·아래 **끝 픽셀**을 짚는다 — `imagePointToScreen` 이 경계를 `>=` 로 막으므로
  //  폭 자체(= 밖)를 넣으면 null 이 된다. 끝 픽셀을 짚고 1을 더해 폭을 되살린다.
  const br = imagePointToScreen(
    { x: rect.x + rect.width - 1, y: rect.y + rect.height - 1 },
    g,
  );
  if (tl === null || br === null) return null;
  return { x: tl.x, y: tl.y, width: Math.max(1, br.x - tl.x + 1), height: Math.max(1, br.y - tl.y + 1) };
};

/**
 * **관측 하나의 기하를 조립한다** — 순수 (2026-09-17, §14-3).
 *
 * ★조작이 서는 바닥이다. 여기가 틀리면 **엉뚱한 데를 누른다** — 그래서 순수 함수로 두고
 *  회귀가 실행해서 잰다(실행부에 두면 데몬을 띄워야 검사할 수 있다).
 * ★`capturedPx` 를 **재지 않고 유도한다**: 화면 캡처는 «그 화면의 픽셀 크기», 영역 캡처는
 *  «요청한 포인트 × 배율». 둘 다 이미 아는 값이라 자식 프로세스를 더 띄우지 않는다.
 * ★`deliveredPx` 만 **실측을 받는다** — 줄이기가 반올림을 하므로 유도하면 1px 씩 어긋나고,
 *  그 어긋남은 배율이 곱해져 화면에서 2px 오차가 된다.
 */
/**
 * 이 캡처의 **기하를 대는 화면**을 고른다 — 순수.
 *
 * ★★**종전엔 `screens[0]` 을 무조건 썼다** (2026-09-18, 회사돌쇠 4차). 어느 디스플레이를
 *  찍었는지와 **무관하게** 주 화면 것을 붙였고, 그래서 `display:2` 로 찍은 그림의 원점이
 *  `{0,0}` 으로 잡혔다 — 보조 화면의 (800,450) 을 누르면 **주 화면의 (1280,720)** 이
 *  눌린다. ★**거절되지도 않는다**: 화면 안의 멀쩡한 좌표라서 모든 검사를 통과한다.
 *  관측 응답이 «한 디스플레이만 담습니다, `display` 를 쓰세요» 라고 권하는 길이라 더 나쁘다.
 *  DPI 가 다른 모니터면 `scale` 도 같은 자리에서 주 화면 값으로 잡힌다.
 *
 * ★3차엔 프레임 자체가 등록되지 않아(P0) **이 경로에 닿을 수조차 없었다** — 결함이 결함을
 *  가린 세 번째다.
 *
 * ★못 고르면 `null` 이다. 호출부는 그때 **프레임을 등록하지 않는다** — 좌표를 지어내느니
 *  «그 화면을 모른다» 가 낫다(§14-3 의 규칙 그대로).
 */
/**
 * **행동 뒤에 무엇을 다시 볼 것인가** — 순수 (2026-09-19, 아스트라 외부 검토).
 *
 * ★★종전엔 `do` 가 사후 장면을 `{kind:"screen"}` **리터럴로 고정**해서 찍었다. 그래서
 *  보조 모니터 프레임 위에서 행동해도 **주 모니터**가 돌아왔다 — 모델이 **다른 화면으로
 *  행동 결과를 판정**하게 된다. 그림이 잘못 온 정도가 아니라 판정 자체가 어긋난다.
 * ★`region` 은 **그 화면 전체로 넓힌다**: 행동은 확대한 네모 **밖**도 바꾼다(창이 열리고
 *  대화상자가 뜬다). 확대 그림만 돌려주면 그걸 못 본다.
 * ★★**모르면 넓히지 않는다** — 화면 배치를 못 읽으면 `region` 을 그대로 둔다.
 *  주 화면으로 **조용히 갈아타지 않는다**(그게 이 결함의 내용이었다).
 */
export const afterActionTarget = (
  target: CaptureTarget,
  screens: readonly ScreenRect[] | undefined,
): CaptureTarget => {
  if (target.kind !== "region") return target;
  if (screens === undefined || screens.length === 0) return target;
  // ★★**`screenForTarget` 과 같은 기준을 쓴다**(2026-09-19, 아스트라 재검토 §4). 종전엔
  //  여기가 «첫 교차» 이고 저기가 «최대 겹침» 이라, 두 화면에 **걸친** region 에서
  //  **좌표 기준 화면과 사후 관측 화면이 갈릴 수** 있었다. 기준이 둘이면 언젠가 갈린다.
  const idx = screenIndexForRect(target, screens);
  return idx < 0 ? target : { kind: "display", index: idx + 1 };
};

/**
 * **이 네모가 가장 많이 걸친 화면의 번호**(0-기준, 없으면 −1) — 순수.
 *
 * ★겹치는 **넓이**로 고른다. 「첫 교차」로 고르면 화면 배열 **순서**에 답이 달린다 —
 *  같은 배치인데 열거 순서가 바뀌면 다른 화면이 나온다.
 */
export const screenIndexForRect = (
  r: { x: number; y: number; width: number; height: number },
  screens: readonly ScreenRect[],
): number => {
  let best = -1;
  let bestArea = 0;
  for (let i = 0; i < screens.length; i += 1) {
    const s = screens[i];
    if (s === undefined) continue;
    const w = Math.min(r.x + r.width, s.x + s.w) - Math.max(r.x, s.x);
    const h = Math.min(r.y + r.height, s.y + s.h) - Math.max(r.y, s.y);
    if (w > 0 && h > 0 && w * h > bestArea) {
      bestArea = w * h;
      best = i;
    }
  }
  return best;
};

export const screenForTarget = (
  target: CaptureTarget,
  screens: readonly ScreenRect[] | undefined,
): ScreenRect | null => {
  if (screens === undefined || screens.length === 0) return null;
  if (target.kind === "screen") return screens[0] ?? null;
  if (target.kind === "display") return screens[target.index - 1] ?? null;
  // 영역은 **전역 좌표**다 — 그 사각형이 실제로 놓인 화면을 고른다. 두 화면에 걸치면
  // **겹친 면적이 가장 큰** 쪽(원점은 영역 자신이 대고, 화면은 배율만 댄다).
  // ★★**판정은 `screenIndexForRect` 한 곳뿐이다** (2026-09-19, 아스트라 3차 §6). 종전엔
  //  같은 루프가 두 벌이었다 — 지금은 답이 같지만, 같은 계약의 구현이 둘이면 **다음
  //  수정에서 갈린다**(그 갈림이 정확히 이번에 고친 «첫 교차 vs 최대 겹침» 이었다).
  const idx = screenIndexForRect(target, screens);
  return idx < 0 ? null : (screens[idx] ?? null);
};

export const frameGeometry = (
  target: CaptureTarget,
  screen: ScreenRect,
  deliveredPx: { w: number; h: number },
): FrameGeometry => {
  const scale = screen.scale ?? 1;
  const region = target.kind === "region";
  return {
    deliveredPx,
    capturedPx: region
      ? { w: Math.round(target.width * scale), h: Math.round(target.height * scale) }
      : { w: Math.round(screen.w * scale), h: Math.round(screen.h * scale) },
    originPt: region ? { x: target.x, y: target.y } : { x: screen.x, y: screen.y },
    scale,
  };
};

/**
 * **실행부 계약** — `mac.ts`·`win.ts` 가 이 모양이다.
 *
 * ★구현이 **둘이 됐을 때** 생긴 자리다(하나뿐일 땐 안 만들었다 — «3회 반복 후 추상화» 의
 *  중간값). 순수부에 **타입만** 두는 이유: 여기엔 `spawn` 이 없어야 하고, 그래야 인덱스가
 *  플랫폼을 고를 때 «무엇을 고르는지» 가 한 줄로 읽힌다.
 * ★`info` 는 **선택**이다 — Windows 는 화면 수·DPI 선언 결과를 실어 보내고 mac 은 안 보낸다.
 */
export type PreflightResult =
  | { ok: true; info?: string; screens?: readonly ScreenRect[] }
  | { ok: false; reason: "timeout" | "failed"; detail: string };

export type CaptureResult =
  | {
      ok: true;
      bytes: number;
      longEdge: number;
      path: string;
      info?: string;
      /**
       * 모델에 실린 그림의 **실측** 픽셀 크기. 기하의 분모다(§14-3).
       *
       * ★★**필수다. 못 쟀으면 `null` 이라고 «말해야» 한다** (2026-09-18, 회사돌쇠 3차).
       *  종전엔 `?` 였고, 그래서 Windows 실행부가 **이 필드를 아예 안 내도 계약에 들어맞았다.**
       *  결과는 조용했다: 프레임이 한 번도 등록되지 않아 `frameId` 가 영영 발급되지 않았고,
       *  **조작 도구 다섯이 호출조차 불가능**한데 관측은 멀쩡히 성공을 반환했다.
       *  선택 필드는 «빠뜨릴 수 있는 필드» 다 — 이음매를 선택으로 두지 않는다.
       */
      deliveredPx: { w: number; h: number } | null;
    }
  | { ok: false; reason: "timeout" | "failed"; detail: string };

/**
 * **조작 실행부 계약** — 관측과 **따로 둔다**.
 *
 * ★이유: 플랫폼마다 «관측은 되는데 조작은 아직» 이 실제로 존재한다(2026-09-17 현재
 *  Windows 가 그렇다). 하나로 묶으면 그 상태를 표현할 수 없어서 **있는 척하는 도구**가
 *  생긴다 — 관측이 «다른 플랫폼에선 도구를 아예 안 낸다» 로 지킨 규율과 같은 것이다.
 */
export interface ControlBackend {
  /** 조작 권한 — **프롬프트 없이** 읽는다. 없으면 켜는 법을 말하고 끝낸다. */
  controlPreflight(): Promise<
    { ok: true } | { ok: false; reason: "no-permission" | "timeout" | "failed"; detail: string }
  >;
  /** 사람이 마지막으로 **하드웨어**를 만진 뒤 경과 초. 모르면 null(=«쓰는 중»). */
  idleSeconds(): Promise<number | null>;
  /** 이벤트를 순서대로 쏜다. ★«오류 없음» 이 «했다» 가 아니다 — 권한은 위에서 본다. */
  post(
    events: readonly import("./control.js").LowEvent[],
  ): Promise<
    | {
        ok: true;
        /**
         * 실제로 **쏜 횟수**.
         *
         * ★★**«앱이 받았다» 가 아니다** (2026-09-19, 아스트라 §4). 종전 이름은 `sent` 였고
         *  실행부가 루프 **밖에서 «받은 항목 수»** 를 세어 냈다 — **빈 연습에서 한 번도 안
         *  쐈는데 같은 수**가 나왔다. 그리고 실기에서 «`{ok:true, sent:1}` 인데 0자» 가
         *  나왔을 때, 그 수가 **아무것도 보장하지 않는다**는 것이 드러났다.
         * ★이름이 읽는 쪽을 속이면 그게 다음 오진이다. 효과의 판정은 **재관측뿐**이다.
         */
        fired: number;
        /** 자식이 흘린 진행 줄 — `stepsOutcome` 이 «어디까지 갔나» 를 읽는다(계약 3). */
        stdout: string;
      }
    | { ok: false; reason: "timeout" | "failed"; detail: string; stdout: string }
  >;
  /**
   * **지금 전면 창** — 열 안의 가드가 비교할 기준값(계약 1). 못 읽으면 `null`.
   *
   * ★**정밀도가 플랫폼마다 다르다**: mac 은 `앱이름:pid`(앱 단위) · Windows 는 HWND(창 단위).
   *  맥은 **같은 앱의 다른 창**으로 옮겨간 것을 못 본다 — 확인된 제한이고 `look` 이 말한다.
   */
  frontWindow(): Promise<string | null>;
}

export interface ObserveBackend {
  preflight(): Promise<PreflightResult>;
  capture(target: CheckedTarget, outPath: string): Promise<CaptureResult>;
}

/**
 * **Windows 캡처 스크립트에 넘길 환경변수** — 순수. 실행은 `win.ts` 가 한다.
 *
 * ★**인자를 문자열로 끼워 넣지 않는다.** mac 은 `execFile` 이 argv 를 그대로 넘겨 안전하지만
 *  PowerShell 은 `-Command` 에 **문자열 한 덩이**를 받아 다시 파싱한다 — 경로에 `'` 나 `;`
 *  가 있으면 그게 **코드가 된다.** 파일 이름엔 `threadKey` 가 들어가고 그건 바깥에서 온다.
 *  그래서 스크립트는 **고정 리터럴**이고 변하는 값은 전부 `$env:` 로 건넨다(따옴표 0개).
 *
 * ★단위가 mac 과 다르다: `region` 은 여기선 **픽셀**(가상 데스크톱 좌표)이고, mac 의
 *  `screencapture -R` 은 **포인트**다. 스크립트가 자기 프로세스를 DPI-aware 로 만들기
 *  때문에 Windows 쪽은 픽셀=픽셀이다 — 2단계 기하에선 이쪽이 오히려 단순하다(배율 1).
 */
export const winCaptureEnv = (
  target: CaptureTarget | { kind: "probe" },
  outPath: string,
  opts?: { longEdge?: number; quality?: number },
): Record<string, string> => {
  const base: Record<string, string> = {
    TIGUCLAW_OUT: outPath,
    TIGUCLAW_LONG_EDGE: String(opts?.longEdge ?? FRAME_LONG_EDGE),
    TIGUCLAW_QUALITY: String(opts?.quality ?? FRAME_QUALITY),
    TIGUCLAW_MODE: target.kind,
  };
  switch (target.kind) {
    case "screen":
    case "probe":
      return base;
    case "display":
      return { ...base, TIGUCLAW_DISPLAY: String(target.index) };
    case "region":
      return {
        ...base,
        TIGUCLAW_X: String(target.x),
        TIGUCLAW_Y: String(target.y),
        TIGUCLAW_W: String(target.width),
        TIGUCLAW_H: String(target.height),
      };
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
  platform: string,
): string | null => {
  if (probe.ok) return null;
  // ★**플랫폼마다 «할 일» 이 다르다.** mac 은 «권한을 켜라» 지만 Windows 엔 그 권한이 아예
  //  없고, 대신 «데스크톱 세션이 있느냐» 가 그 자리를 차지한다. 맥 문구를 그대로 내보내면
  //  Windows 사용자는 **있지도 않은 설정 화면**을 찾으러 간다.
  if (platform === "win32") return winPreflightMessage(probe);
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
  return `화면을 찍지 못했습니다${whyLine(probe.detail ?? "")}. 대상(디스플레이 번호·영역)이 맞는지 확인해 주세요.`;
};

/**
 * 실패 사유에서 **사용자에게 줄 한 조각**만 뽑는다 — 순수.
 *
 * ★**빈 줄을 빼고** 마지막 의미 있는 줄을 쓴다. `execFile` 의 메시지는
 *  `Command failed: <명령줄>\n<stderr>\n` 이라 그냥 `pop()` 하면 **항상 빈 문자열**이 되고,
 *  그러면 사유가 **한 번도 안 실린다**(겉보기엔 «유출 없음» 이라 검사도 통과한다).
 * ★★경로·명령줄이 섞인 줄은 버린다. 종전엔 `/` 만 걸렀는데 **Windows 경로는 `\`** 라
 *  `C:\Users\…\tiguclaw-screen-probe-…png` 가 그대로 샜다 — 같은 유출을 mac 에서 두 번
 *  막아놓고 형제 플랫폼에서 다시 연 셈이다.
 */
const whyLine = (detail: string): string => {
  const lines = detail
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const why = lines[lines.length - 1] ?? "";
  return why !== "" && !/[/\\]/.test(why) ? ` — ${why.slice(0, 120)}` : "";
};

/**
 * **Windows 의 «할 일»** — 순수.
 *
 * ★mac 의 «화면 기록 권한» 에 해당하는 것이 Windows 엔 **없다**(캡처에 권한 프롬프트가
 *  없다). 대신 그 자리를 **세션**이 차지한다: 데몬이 서비스(Session 0)로 떠 있으면 사용자
 *  데스크톱이 아예 안 보이고, 그때 .NET 은 «handle is invalid» 로 던지거나 화면을 0개로
 *  센다. 그걸 «캡처 실패» 로만 말하면 사용자가 고칠 수가 없다 — **무엇을 바꿔야 하는지**를
 *  말한다.
 */
const winPreflightMessage = (probe: {
  ok: false;
  reason: "timeout" | "failed";
  detail?: string;
}): string => {
  const detail = probe.detail ?? "";
  // ★★**백신이 막은 것을 «파싱 오류» 라고 말하지 않는다** (2026-09-18, 집 Windows 실기).
  //  AMSI 가 캡처 스크립트를 차단하면 PowerShell 이 `ParserError` 계열 부속 줄을 뱉는데,
  //  그걸 그대로 실으면 **스크립트 문법 문제로 읽힌다**(실제로 내가 세 번 뜯어봤다).
  //  ★억울하지만 신호는 이해된다 — `Add-Type` 으로 P/Invoke 를 선언하고, 화면을 캡처하고,
  //   base64 로 인코딩된 채 실행된다. 화면 훔쳐보는 악성코드의 서명 그대로다.
  //  ★★그리고 **조작은 되는데 관측만 막힌다**(입력 스크립트는 안 걸렸다) — 그 상태를
  //   «둘 다 고장» 으로 읽으면 엉뚱한 데를 고친다.
  if (/ScriptContainedMaliciousContent|malicious content/i.test(detail)) {
    return (
      "화면을 찍지 못했습니다 — **보안 소프트웨어(백신)가 캡처 스크립트를 차단했습니다.**\n" +
      "문법 오류가 아닙니다. 화면 캡처 스크립트가 `Add-Type` 으로 시스템 함수를 선언하고 " +
      "화면을 읽기 때문에, 일부 백신이 이를 악성으로 분류합니다.\n" +
      "★**클릭·입력은 그대로 될 수 있습니다** — 막힌 것은 캡처뿐입니다. 그래서 «보고 누르는» " +
      "작업만 안 됩니다.\n" +
      "해결하려면 백신에서 **PowerShell 스크립트 검사 예외**를 두거나, 이 기계에서는 화면 관측을 " +
      "쓰지 않는 쪽으로 판단해 주세요."
    );
  }
  if (/no-desktop|handle is invalid|invalid handle/i.test(detail)) {
    return (
      "화면을 찍지 못했습니다 — **데스크톱 세션이 없습니다.**\n" +
      "데몬이 서비스(Session 0)로 떠 있으면 사용자 화면이 보이지 않습니다. " +
      "로그인한 사용자 세션에서 실행되도록 바꿔 주세요(작업 스케줄러라면 «사용자가 로그온" +
      "할 때만 실행»)."
    );
  }
  if (probe.reason === "timeout") {
    return (
      "화면을 찍지 못했습니다 — PowerShell 이 시한 안에 끝나지 않았습니다.\n" +
      "Windows 엔 화면 캡처 권한 대화상자가 없으므로 권한 문제는 아닙니다. " +
      "그 기계가 매우 느리거나 PowerShell 실행 정책·보안 소프트웨어가 막고 있을 수 있습니다."
    );
  }
  return `화면을 찍지 못했습니다${whyLine(detail)}. 대상(디스플레이 번호·영역)이 맞는지 확인해 주세요.`;
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
  /**
   * 제한 문구가 플랫폼마다 다르다.
   *
   * ★★**기본값을 두지 않는다**(2026-09-17, 회사돌쇠 실기 P2). 종전엔 `process.platform` 을
   *  기본값으로 뒀는데, 그러면 **순수 함수에 숨은 전역 입력**이 생긴다 — 같은 검사가 맥에선
   *  통과하고 Windows 에선 실패했다(회귀 2건). 게이트가 호스트에 따라 갈리면 그 플랫폼에선
   *  상시 FAIL 이고, 상시 FAIL 인 게이트는 **아무도 안 돌린다**
   *  ([[feedback_gate_must_actually_run]]). 호출부가 말하게 한다.
   */
  platform: string;
  /**
   * 이 관측의 **프레임 id** — 조작 도구가 이 값을 받는다(§14-3).
   *
   * ★없으면 **조작을 못 한다**(기하를 못 냈다는 뜻). 그 사실을 말해 준다 — 모델이 «클릭이
   *  왜 안 되지» 로 헤매지 않게.
   */
  frameId?: string;
  /** 화면에 맞춰 **잘렸으면** 원래 요청 — 있으면 «요청/실제» 를 같이 싣는다. */
  clippedFrom?: { x: number; y: number; width: number; height: number };
  /**
   * 이 영역이 걸친 화면 수. 2 이상이면 **화면 사이 빈 공간**이 검게 담길 수 있다.
   *
   * ★정책은 «거절» 이 아니라 «말한다» 다 — 두 화면에 걸친 사각형은 가상 데스크톱에서 실제로
   *  그 모양이고, 빈 공간이 검은 것도 사실이다. 잠금 화면이 검게 나오는 것과 같은 부류라
   *  거절이 아니라 «확인된 제한» 에 속한다.
   */
  spansScreens?: number;
}): string => {
  const what =
    o.target.kind === "screen"
      ? "주 디스플레이 전체"
      : o.target.kind === "display"
        ? `디스플레이 ${o.target.index}`
        // ★**«화면 좌표» 라고 밝힌다** (2026-09-17 돌쇠 3차). 모델이 준 것은 그림 좌표인데
        //  여기 돌아오는 것은 옮긴 값이라, 라벨이 없으면 «어긋났나?» 로 읽힌다.
        : `영역 ${o.target.width}×${o.target.height} @(${o.target.x},${o.target.y}) — 화면 좌표(당신이 준 그림 좌표를 옮긴 값)`;
  // ★잘렸으면 **잘렸다고 말한다.** 조용히 자르면 모델이 요청한 좌표와 그림이 어긋나고,
  //  그 어긋남은 2단계 좌표 계약에서 그대로 오클릭이 된다.
  const clip =
    o.clippedFrom === undefined
      ? null
      : `★요청한 영역(${o.clippedFrom.width}×${o.clippedFrom.height} @(${o.clippedFrom.x},${o.clippedFrom.y}))의 ` +
        `일부가 화면 밖이라 **화면 안쪽만** 찍었습니다 — 위 «관측» 줄이 실제 범위입니다.`;
  const spanNote =
    o.spansScreens !== undefined && o.spansScreens > 1
      ? `★이 영역은 화면 ${String(o.spansScreens)}개에 걸쳐 있습니다 — 화면과 화면 **사이 빈 공간**은 검게 담깁니다.`
      : null;
  return [
    `관측: ${what}`,
    ...(clip === null ? [] : [clip]),
    ...(spanNote === null ? [] : [spanNote]),
    `시각: ${o.at.toISOString()}`,
    `크기: ${describeLongEdge(o.longEdge)} · ${o.bytes.toLocaleString()}바이트`,
    `저장: ${o.savedPath}`,
    o.frameId === undefined
      ? "조작: 이 관측으로는 **클릭·입력을 할 수 없습니다**(화면 기하를 못 읽었습니다)."
      : `화면 id: ${o.frameId} — 클릭·입력할 때 이 값을 주세요. ★좌표는 **이 그림의 픽셀**입니다(왼쪽 위가 0,0).`,
    // ★«확인된 제한» 은 **플랫폼마다 다르다.** 맥의 «권한 없으면 바탕화면만» 을 Windows 에
    //  그대로 내보내면 있지도 않은 설정을 찾게 만든다. (2)는 양쪽 공통이다.
    `확인된 제한: ${
      o.platform === "win32"
        ? "(1) 잠금 화면·보호된 콘텐츠(DRM 재생 창)·관리자 권한 대화상자(보안 데스크톱)는 " +
          "검게 나오거나 아예 담기지 않습니다. 비어 보인다고 «없다» 로 읽지 마세요. " +
          // ★2026-09-17 회사돌쇠 재검증에서 실제로 헷갈린 자리: 창이 API 로는 «있고
          //  보인다»(IsWindowVisible=true)는데 캡처엔 없었다. 우리는 **화면에 합성된 픽셀**을
          //  읽으므로 «아직 안 그려진 창» 은 정직하게 안 보인다 — 그게 맞는 동작이지만,
          //  모르면 «캡처가 고장» 으로 읽힌다.
          "★이 관측은 **화면에 실제로 그려진 것**을 담습니다 — 창이 «존재하고 보이는» 상태여도 " +
          "아직 그려지지 않았으면(메시지 루프 없이 만든 창 등) 여기 안 나옵니다."
        : "(1) 화면 기록 권한이 없으면 macOS 가 오류 대신 바탕화면만 담긴 그림을 줄 수 있습니다. " +
          "보이는 것이 기대와 다르면 권한부터 확인하세요 — 그림만으로는 구분할 수 없습니다."
    } (2) 이 관측은 **한 디스플레이**만 담습니다. 모니터가 여럿이면 나머지는 여기 없습니다 — ` +
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
  // ★경계는 `>=` 다 — **폭 값 자체는 이미지 밖**이다(픽셀 인덱스는 0..w-1). 종전엔 `>` 라
  //  오른쪽·아래 가장자리 1px 이 통과했다(§14-3 에 적어두고 호출부가 없어 미뤘던 한 줄).
  if (img.x < 0 || img.y < 0 || img.x >= d.w || img.y >= d.h) return null;
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

// ★**리스·사용자 가드·행동 판정은 여기 없다** — `control.ts` 로 갔다 (2026-09-17).
//  처음엔 여기 «2단계: 조작» 자리에 같이 뒀는데, 조작 판단이 늘자 **같은 판단이 두 곳**이
//  될 뻔했다([[feedback_simple_composable_no_duplication]] — 중복은 파일 수가 아니라
//  «같은 판단이 두 곳» 이다). 기하(`imagePointToScreen`·`deriveScale`)만 여기 남는다 —
//  그건 **관측이 내는 값**이고 조작은 그걸 받아 쓰는 쪽이다.
