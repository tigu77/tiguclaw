/** 반복 예약 패널: 기존 타이머 계약에 안전 메타만 가산하며 예약을 실행으로 만들지 않는다. */
import { initStore } from "../../store/sessions.js";
import { addSchedule, deleteSchedule, getSchedule, listSchedules, updateSchedule } from "../../store/schedules.js";
import { assert, assertIsolated, loadPluginModule, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "schedule-panel-api",
  guards: "반복 예약이 백그라운드 패널에 없고, 실행 프롬프트를 상세로 노출하거나 꺼진/전용세션을 추정할 위험",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    initStore();
    const routes = await loadPluginModule<{ handleTimers: (ctx: unknown) => Promise<void> }>("../../../plugins/http-bridge/routes-work.ts");
    const prompt = "PRIVATE-PROMPT-NOT-A-DESCRIPTION";
    const destTarget = "PRIVATE-DEST-NOT-A-THREAD";
    const beforeIds = listSchedules().map((r) => r.id);
    const cleanup: number[] = [];
    const out: Assertion[] = [];
    try {
      const cron = addSchedule({ label: "패널 활성 cron", prompt, cronExpr: "0 8 * * *", timezone: "Asia/Seoul", destChannel: "test-no-send", destTarget, originThreadKey: "dashboard:panel-api" });
      cleanup.push(cron.id);
      const off = addSchedule({ label: "패널 꺼진 cron", prompt, cronExpr: "0 9 * * *", destChannel: "test-no-send", destTarget, originThreadKey: null });
      cleanup.push(off.id);
      updateSchedule(off.id, { enabled: false });
      const boot = addSchedule({ label: "패널 reboot", prompt, cronExpr: "", triggerType: "reboot", destChannel: "test-no-send", originThreadKey: "dashboard:other" });
      cleanup.push(boot.id);
      const invalid = addSchedule({ label: "패널 계산 불가", prompt, cronExpr: "not a cron", destChannel: "test-no-send" });
      cleanup.push(invalid.id);
      const once = addSchedule({ label: "패널 기존 once", prompt, cronExpr: "", triggerType: "once", runAt: Date.now() + 600_000, destChannel: "test-no-send", originThreadKey: "dashboard:panel-api" });
      cleanup.push(once.id);
      const res = { body: "", status: 0, writeHead(s: number) { this.status = s; return this; }, setHeader() {}, end(b: string) { this.body = b; } };
      await routes.handleTimers({ res });
      type Row = { id: number; enabled: boolean; nextRun: number | null; originThreadKey: string | null; triggerType: string };
      const body = JSON.parse(res.body) as { timers: Row[]; schedules: Row[] };
      const byId = (id: number) => body.schedules.find((r) => r.id === id);
      const expectedKeys = ["id", "label", "triggerType", "cronExpr", "timezone", "originThreadKey", "enabled", "nextRun"].sort();
      const beforeMove = byId(cron.id);
      out.push(
        assert("기존 timers는 once만, schedules는 cron/reboot 별도 배열", body.timers.some((r) => r.id === once.id) && !body.timers.some((r) => r.id === cron.id) && !body.schedules.some((r) => r.id === once.id) && [cron.id, off.id, boot.id, invalid.id].every((id) => byId(id) !== undefined), body),
        assert("반복 예약은 허용된 안전 메타만 반환하고 prompt/발송대상/자유 오류를 제외", body.schedules.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(expectedKeys)) && !JSON.stringify(body.schedules).includes(prompt) && !JSON.stringify(body.schedules).includes(destTarget), body.schedules),
        assert("활성 cron 다음 실행은 실제 미래 epoch, 꺼짐/reboot/잘못된 cron은 null", typeof beforeMove?.nextRun === "number" && beforeMove.nextRun > Date.now() && byId(off.id)?.nextRun === null && byId(off.id)?.enabled === false && byId(boot.id)?.nextRun === null && byId(invalid.id)?.nextRun === null, body.schedules),
        assert("현재 origin과 null 전용 대화는 발송대상 추정 없이 전달", beforeMove?.originThreadKey === "dashboard:panel-api" && byId(off.id)?.originThreadKey === null && byId(boot.id)?.originThreadKey === "dashboard:other", body.schedules),
      );
      updateSchedule(cron.id, { originThreadKey: "dashboard:moved" });
      await routes.handleTimers({ res });
      out.push(assert("세션 이동을 다음 조회가 반영하고 GET은 예약/once를 소비하지 않음", JSON.parse(res.body).schedules.find((r: Row) => r.id === cron.id)?.originThreadKey === "dashboard:moved" && [cron.id, off.id, boot.id, invalid.id, once.id].every((id) => getSchedule(id) !== undefined), JSON.parse(res.body)));
    } finally {
      for (const id of cleanup) deleteSchedule(id);
    }
    const afterIds = listSchedules().map((r) => r.id);
    out.push(assert("합성 예약 정리 뒤 기존 예약 ID 목록을 보존", JSON.stringify(afterIds) === JSON.stringify(beforeIds), { beforeIds, afterIds }));
    return out;
  },
};
