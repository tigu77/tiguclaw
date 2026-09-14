/**
 * 회귀: **자동 재전송은 «보내기 직전» 의 스케줄을 본다** (2026-09-14)
 *
 * 잡는 결함(외부 검토): 전달 실패 뒤 5분 재전송이 타이머 closure 의 **옛 스냅샷**으로
 * 나갔다. 최신 행을 조회하긴 했는데 **존재 여부만** 보고 버렸다 — 그래서 그 5분 사이에
 * 사용자가 스케줄을 **끄거나 목적지를 바꿔도** 옛 주소로 다시 나갔다.
 *
 * ★조회해놓고 안 쓰는 코드는 «확인했다» 처럼 보여서 더 나쁘다. 여기서는 **실제 발송 인자**를
 *  관측해 그 사실을 잰다(존재 확인이 아니라 «무엇으로 보냈나»).
 *
 * 정책(정태님 확정 2026-09-14):
 *  - 삭제·비활성 → 대기 중 재전송 **취소**
 *  - 목적지 변경 → 대기 중 발송 **취소**(옛 목적지 금지), 새 목적지는 **다음 정기 실행부터**
 *  - 취소를 성공(`recordFiring ok`)이나 `scheduler.recovered` 로 기록하지 않는다
 *  - 원문은 지우지 않는다(발송 취소와 기록 삭제는 별개)
 *
 * 등급: **동작 검사** — 실제 `runScheduleFiring` → 실패 → 재전송 타이머를 돌린다. LLM 0.
 */
import {
  addSchedule,
  deleteSchedule,
  getSchedule,
  updateSchedule,
} from "../../store/schedules.js";
import { getEventBus } from "../../core/eventbus.js";
import {
  assert,
  assertIsolated,
  loadPluginModule,
  type Assertion,
  type RegressionCheck,
} from "./_framework.js";

/** ★플러그인 소스는 **빌드 프로그램에 안 끌어들이고** 부른다(`_framework` 주석 참조) —
 *  리터럴 지정자로 `plugins/…` 를 import 하면 `npm run build`(rootDir=src)가 TS6059 로 죽는다.
 *  이 레포가 이미 한 번 데인 자리이고, 방금 그 게이트가 이 파일을 잡았다. */
type RunnerMod = {
  runScheduleFiring: (schedule: unknown, bus: unknown, deps: unknown) => Promise<void>;
};

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Sent { destChannel: string; destTarget: string | null; text: string }

/**
 * 한 판: 발화 → 첫 전달 실패 → (그 사이 사용자가 무엇을 함) → 재전송 시점 관측.
 * 반환은 **실제 발송된 것**과 기록이다.
 */
const runOnce = async (
  mutate: (id: number) => void,
): Promise<{ id: number; sent: Sent[]; firings: Array<{ ok: boolean }>; recovered: number }> => {
  const row = addSchedule({
    label: "재전송 시험",
    cronExpr: "0 9 * * *",
    prompt: "!say 고정 문구",      // 직송 — LLM 경유 0.
    destChannel: "regr-dest-a",
    destTarget: "t-a",
  });
  const sent: Sent[] = [];
  const firings: Array<{ ok: boolean }> = [];
  let recovered = 0;
  const bus = getEventBus();
  const off = bus.subscribe?.((e: { type: string }) => {
    if (e.type === "scheduler.recovered") recovered += 1;
  });
  let first = true;
  const { runScheduleFiring } = await loadPluginModule<RunnerMod>(
    "../../../plugins/scheduler/src/runner.ts",
  );
  await runScheduleFiring(row, bus as never, {
    runRegionA: async () => ({ text: "안 쓰임" }),
    recordFiring: (_id: number, r: { ok: boolean }) => { firings.push({ ok: r.ok }); },
    dispatch: (async (a: { destChannel: string; destTarget: string | null; text: string }) => {
      if (first) { first = false; throw new Error("전달 실패(모의)"); }
      sent.push({ destChannel: a.destChannel, destTarget: a.destTarget, text: a.text });
    }) as never,
    retryDelayMs: 20,             // 5분을 기다리지 않는다.
    cwd: process.cwd(),
  } as never);
  mutate(row.id);                 // ★첫 실패와 재전송 사이에 사용자가 한 일.
  await wait(160);                // 타이머가 돌 시간.
  if (typeof off === "function") off();
  return { id: row.id, sent, firings, recovered };
};

export const check: RegressionCheck = {
  name: "schedule-retry-reads-latest",
  guards:
    "전달 실패 뒤 자동 재전송이 타이머 closure 의 옛 스냅샷으로 나가, 그 사이 스케줄을 끄거나 목적지를 바꿔도 옛 주소로 다시 나가던 것 (2026-09-14 외부 검토)",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const out: Assertion[] = [];

    // ① 아무것도 안 건드리면 — 정상 복구(같은 목적지로 1회).
    {
      const r = await runOnce(() => {});
      out.push(
        assert(
          "정상 복구: 같은 목적지로 **한 번** 재전송된다",
          r.sent.length === 1 && r.sent[0]?.destChannel === "regr-dest-a" && r.sent[0]?.destTarget === "t-a",
          `발송 ${r.sent.length}건 · ${r.sent[0]?.destChannel ?? "—"}/${r.sent[0]?.destTarget ?? "—"}`,
        ),
      );
    }

    // ② 비활성화 → 취소. 성공으로 기록하지 않는다.
    {
      const r = await runOnce((id) => { updateSchedule(id, { enabled: false }); });
      out.push(
        assert(
          "★★비활성화하면 재전송이 **취소**된다 — 끈 스케줄이 5분 뒤 말을 걸면 안 된다",
          r.sent.length === 0,
          `발송 ${r.sent.length}건`,
        ),
        assert(
          "★취소를 **성공으로 기록하지 않는다**(ok 기록·recovered 이벤트 0)",
          !r.firings.some((f) => f.ok) && r.recovered === 0,
          `ok 기록 ${r.firings.filter((f) => f.ok).length}건 · recovered ${r.recovered}건`,
        ),
      );
    }

    // ③ 목적지 변경 → 취소. **옛 목적지로도, 새 목적지로도 안 나간다.**
    {
      const r = await runOnce((id) => {
        updateSchedule(id, { destChannel: "regr-dest-b", destTarget: "t-b" });
      });
      out.push(
        assert(
          "★★목적지가 바뀌면 대기 중 발송을 **취소**한다 — 옛 주소로도 새 주소로도 안 나간다",
          r.sent.length === 0,
          `발송 ${r.sent.length}건 · ${r.sent.map((s) => `${s.destChannel}/${s.destTarget ?? "—"}`).join(",")}`,
        ),
        assert(
          "★**원문은 지우지 않는다** — 발송 취소와 기록 삭제는 별개다",
          (() => {
            const after = getSchedule(r.id);
            return after !== undefined && after.prompt === "!say 고정 문구" && after.enabled;
          })(),
          `행 ${getSchedule(r.id) === undefined ? "사라짐" : "보존"} · prompt=${JSON.stringify(getSchedule(r.id)?.prompt ?? null)}`,
        ),
      );
    }

    // ④ 삭제 → 취소.
    {
      const r = await runOnce((id) => { deleteSchedule(id); });
      out.push(
        assert(
          "삭제되면 재전송이 취소된다",
          r.sent.length === 0,
          `발송 ${r.sent.length}건`,
        ),
      );
    }
    return out;
  },
};
