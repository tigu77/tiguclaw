/**
 * `restart-interrupt-honesty` ④ 의 자식 — **실제 자기 보전 시계**(`startSelfMaintenance`·`stopSelfMaintenance`)를 진짜 이벤트 버스·합성 DB 위에서
 * 돌린다. 네트워크는 가짜(`fakeNetwork` — 틱이 부르는 모델 카탈로그 조회), 시계도 가짜(백업 20시간·깨우기 30초를 기다리지 않는다).
 * ★자식인 이유: `Date.now`·`fetch`·타이머를 바꾸고 모듈 상태(시계·구독)를 쓴다. 출력: 마지막 줄 JSON.
 * 순서: 부팅 틱(첫 백업) → 평상시 turn_error(백업이 새로 뜬다) → 30초 안 turn_error(지연 깨우기 예약) → 멈춤
 *  → 종료 중 기록과 같은 turn_error → 남은 타이머(지연 깨우기·주기 틱)를 시간이 흐른 것처럼 실행. 멈춘 뒤 새 백업 0 이어야 한다.
 */
import { mkdtempSync, readdirSync } from "node:fs";
import path from "node:path";
import { assertIsolated, fakeNetwork } from "./_framework.js";

type FakeTimer = { fn: () => void; cleared: boolean; kind: "timeout" | "interval" };

const main = async (): Promise<void> => {
  assertIsolated();
  process.env.TIGUCLAW_HOME = mkdtempSync(path.join(process.env.TIGUCLAW_HOME!, "selfmaint-"));
  let fetches = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = fakeNetwork(async (): Promise<Response> => {
    fetches += 1;
    return new Response("unavailable", { status: 503 });
  });
  let offset = 0;
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + offset;
  const HOURS_21 = 21 * 3600 * 1000;

  const { initStore } = await import("../../store/sessions.js");
  initStore();
  const backups = (): number => {
    try {
      return readdirSync(path.join(process.env.TIGUCLAW_HOME!, "data", "backup")).filter((f) => f.endsWith(".db")).length;
    } catch {
      return 0;
    }
  };
  const { getEventBus } = await import("../../core/eventbus.js");
  const sm = await import("../../core/self-maintenance.js");
  const bus = getEventBus();
  const turnError = (key: string): void =>
    bus.publish({ type: "llm.turn_error", ts: Date.now(), payload: { threadKey: key, channel: "telegram", error: "x", reason: "daemon-restart" } });

  // 시계 모듈이 거는 타이머만 가짜로 받는다(시작·깨우기·멈춤 구간) — 실제로 기다리지 않고, 멈춘 뒤 «시간이 흐르면» 을 직접 실행한다.
  const timers: FakeTimer[] = [];
  const real = { st: globalThis.setTimeout, si: globalThis.setInterval, ct: globalThis.clearTimeout, ci: globalThis.clearInterval };
  const fake = (kind: FakeTimer["kind"]) => (fn: () => void): unknown => {
    const t: FakeTimer = { fn, cleared: false, kind };
    timers.push(t);
    return { unref: () => t, ref: () => t, hasRef: () => false, __fake: t };
  };
  const clear = (h: unknown): void => {
    const t = (h as { __fake?: FakeTimer } | null)?.__fake;
    if (t !== undefined) t.cleared = true;
  };
  const withFakeTimers = <T>(f: () => T): T => {
    Object.assign(globalThis, { setTimeout: fake("timeout"), setInterval: fake("interval"), clearTimeout: clear, clearInterval: clear });
    try {
      return f();
    } finally {
      Object.assign(globalThis, { setTimeout: real.st, setInterval: real.si, clearTimeout: real.ct, clearInterval: real.ci });
    }
  };

  withFakeTimers(() => sm.startSelfMaintenance(bus));
  const boot = backups();
  offset += HOURS_21; // 백업 기한 도래 · 깨우기 간격 경과
  withFakeTimers(() => turnError("normal"));
  const normal = backups();
  withFakeTimers(() => turnError("soon")); // 방금 점검했다 — 30초 안이라 지연 깨우기가 예약된다
  const deferred = timers.filter((t) => t.kind === "timeout" && !t.cleared).length;
  offset += HOURS_21; // 다시 기한 도래 — 이제 무엇이든 깨면 백업이 뜬다
  withFakeTimers(() => sm.stopSelfMaintenance());
  withFakeTimers(() => turnError("shutdown")); // 종료가 남기는 중단 기록과 같은 이벤트
  const afterStopEvent = backups();
  const live = timers.filter((t) => !t.cleared);
  withFakeTimers(() => {
    for (const t of live) t.fn(); // 시간이 흘러 남은 타이머가 울린다
  });
  const afterTimers = backups();
  console.log(
    JSON.stringify({ boot, normal, deferred, afterStopEvent, afterTimers, liveAfterStop: live.map((t) => t.kind), intervals: timers.filter((t) => t.kind === "interval").length, fetches }),
  );
  process.exit(0);
};
main().catch((e) => {
  console.log(JSON.stringify({ error: String((e as Error)?.message ?? e).slice(0, 200) }));
  process.exit(0);
});
