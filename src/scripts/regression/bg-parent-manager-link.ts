/**
 * 회귀: 백그라운드 패널의 **«↖ 부모 매니저» 버튼** (2026-10-26) — 매니저가 띄운 자식 카드에서 그 매니저 카드로 간다.
 *
 * 지키는 것:
 *  ① 매니저 자식(threadKey `worker:<부모>`)에만 보이고, 이름은 부모 카드의 라벨 그대로다.
 *     ★자식의 **활동**이 와도 남는다 — 종전엔 활동이 싣는 자기 좌표(`agent:<자기>`)가 부모 링크를 덮어썼다(미니 DOM 재현).
 *  ② 메인이 직접 띄운 작업·서브에이전트가 띄운 것(`agent:<부모>`)·자기 좌표만 든 카드엔 없다.
 *  ③ 누르면 부모 카드로 간다(강조) — **펼치지 않는다**(부모 펼침 상태 보존) · 카드 접기로 번지지 않는다 · 가린 필터를 푼다.
 *  ④ 부모 카드가 없으면(목록 상한 밖·미수신) 숨긴다 — 이름을 지어내지 않는다. 상한으로 빠지면 그때 숨는다.
 *  ⑤ 부모가 늦게 오면(활동-선도 → 라이프사이클) 그때 이름과 함께 나타난다 · 새로고침(스냅샷) 경로도 같은 결과.
 *
 * 등급: **동작**(미니 DOM — 실제 background-drawer.js 를 싣는다).
 */
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootDashboard, jsonResponse, makeClock } from "./_mini-dom.js";
import { bgPanelHtml } from "./_bg-panel-fixture.js";

const boot = () => {
  const clock = makeClock();
  const dash = bootDashboard({ html: bgPanelHtml(), clock, i18n: i18nForContext, upTo: "tabs.js", allIds: true, fetch: async () => jsonResponse({}, 404) });
  return { clock, dash };
};
const J = (v: unknown): string => JSON.stringify(v);
/** 버튼 상태 — 보이나·글자·툴팁. */
const btn = (dash: ReturnType<typeof boot>["dash"], id: string): { shown: boolean; text: string; title: string } =>
  dash.run(`(() => { const e = jobCards.get(${J(id)}); const b = e && e.parentBtnEl;
    return b ? { shown: b.style.display !== "none", text: b.textContent, title: b.title } : { shown: false, text: "", title: "" }; })()`);
const ev = (dash: ReturnType<typeof boot>["dash"], p: Record<string, unknown>): void => {
  dash.run(`handleWorkerEvent(${J({ status: "running", ownerThreadKey: "dashboard:default", ...p })}, "t")`);
};

export const check: RegressionCheck = {
  name: "bg-parent-manager-link",
  guards: "매니저가 띄운 자식 카드에서 부모 매니저 카드로 가는 버튼 — 잘못된 카드에 달리거나·이름을 지어내거나·활동에 지워지거나·부모를 펼쳐 버리는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ①②③ 라이브 경로 ────────────────────────────────────────────────────────
    {
      const { clock, dash } = boot();
      ev(dash, { jobId: "M1", label: "조사 매니저", threadKey: "dashboard:default", kind: "worker" });
      ev(dash, { jobId: "C1", agentName: "researcher", label: "자료 찾기", threadKey: "worker:M1", kind: "agent" });
      const mLabel = dash.run(`jobCards.get("M1").label`) as string;
      const before = btn(dash, "C1");
      // 자식이 일한다 — 활동은 자기 좌표(agent:C1)를 싣는다.
      dash.run(`handleWorkerActivity({ threadKey: "agent:C1", kind: "tool", label: "Read", seq: 1 }, "t")`);
      const afterAct = btn(dash, "C1");
      out.push(
        assert(
          "① 매니저 자식에 «↖ <부모 라벨>» 이 보인다 — 이름은 부모 카드의 label 그대로(매니저 접두 포함)",
          before.shown && before.text === "↖ " + mLabel && mLabel.includes("조사 매니저") && before.title.includes(mLabel),
          before,
        ),
        assert(
          "★① 자식의 활동(자기 좌표 agent:C1)이 와도 부모 링크·버튼이 남는다",
          afterAct.shown && afterAct.text === before.text && dash.run(`jobCards.get("C1").threadKey`) === "worker:M1",
          { ...afterAct, threadKey: dash.run(`jobCards.get("C1").threadKey`) },
        ),
      );

      // ② 없어야 하는 카드들.
      ev(dash, { jobId: "A1", agentName: "direct", threadKey: "dashboard:default", kind: "agent" }); // 메인 직접 서브에이전트
      ev(dash, { jobId: "G1", agentName: "grand", threadKey: "agent:C1", kind: "agent" }); // 서브에이전트가 띄운 것
      dash.run(`handleWorkerActivity({ threadKey: "worker:S1", kind: "tool", label: "Bash", seq: 1 }, "t")`); // 자기 좌표만 든 활동-선도 카드
      // 그 카드에 라벨만 든 갱신(좌표 없음 — 알림 등)이 와 이름이 생겨도 «자기 자신» 을 부모로 달지 않는다.
      dash.run(`ensureJobCard("S1", { label: "자기 매니저" })`);
      // 메인 직접 매니저도 활동 뒤 세션 키를 지킨다(같은 덮어쓰기의 형제).
      dash.run(`handleWorkerActivity({ threadKey: "worker:M1", kind: "tool", label: "Bash", seq: 1 }, "t")`);
      const none = ["M1", "A1", "G1", "S1"].map((id) => ({ id, ...btn(dash, id) }));
      out.push(
        assert(
          "② 메인 직접 매니저·메인 직접 서브에이전트·서브에이전트의 자식(agent:)·자기 좌표 카드엔 버튼이 없다",
          none.every((b) => !b.shown),
          none,
        ),
        assert(
          "② 메인 직접 매니저는 자기 활동 뒤에도 세션 키를 지킨다(자기 좌표로 덮이지 않는다)",
          dash.run(`jobCards.get("M1").threadKey`) === "dashboard:default",
          dash.run(`jobCards.get("M1").threadKey`),
        ),
      );

      // ③ 클릭 — 부모가 끝나 «진행 중» 필터에 가려진 상태에서.
      ev(dash, { jobId: "M1", status: "done", result: "끝" });
      dash.run(`jobCards.get("M1").el.classList.remove("open")`);
      dash.run(`setBgFilter("running")`);
      let bubbled = 0;
      (dash.run(`(f) => jobCards.get("C1").el.addEventListener("click", f)`) as (f: () => void) => void)(() => { bubbled += 1; });
      // 화면 밖 부모의 기하를 고정한다 — 강조만 남고 실제 이동이 빠지는 회귀를 잡는다.
      dash.run(`globalThis.parentPane = document.getElementById("bg-scroll");
        parentPane.scrollTop = 11; parentPane.clientHeight = 300; parentPane.scrollHeight = 2000;
        parentPane.getBoundingClientRect = () => ({ top: 0, bottom: 300 });
        jobCards.get("M1").el.getBoundingClientRect = () => ({ top: 500, bottom: 600, height: 100 });`);
      dash.run(`jobCards.get("C1").parentBtnEl.click()`);
      await clock.advance(50);
      out.push(assert("★③ 화면 밖 부모의 윗변까지 실제로 스크롤한다(강조만 하는 회귀 방지)",
        dash.run(`parentPane.scrollTop`) === 503, { before: 11, after: dash.run(`parentPane.scrollTop`) }));
      const r1 = dash.run(`({ flash: jobCards.get("M1").el.classList.contains("bg-flash"), mOpen: jobCards.get("M1").el.classList.contains("open"),
        cOpen: jobCards.get("C1").el.classList.contains("open"), filter: bgFilter, bgOpen: document.body.classList.contains("bg-open") })`);
      out.push(
        assert(
          "③ 누르면 부모 카드로 간다(강조·패널 열림) · 끝난 부모를 가린 «진행 중» 필터를 «완료» 로 푼다",
          r1.flash === true && r1.bgOpen === true && r1.filter === "done",
          r1,
        ),
        assert(
          "★③ 부모를 **펼치지 않는다**(접힌 채 둔다) · 자식 카드 접기로 번지지 않는다(전파 멈춤)",
          r1.mOpen === false && r1.cOpen === false && bubbled === 0,
          { ...r1, bubbled },
        ),
      );
      // 펼쳐져 있던 부모는 펼친 채.
      await clock.advance(1000);
      dash.run(`jobCards.get("M1").el.classList.add("open")`);
      dash.run(`jobCards.get("C1").parentBtnEl.click()`);
      await clock.advance(50);
      const r2 = dash.run(`({ flash: jobCards.get("M1").el.classList.contains("bg-flash"), mOpen: jobCards.get("M1").el.classList.contains("open") })`);
      out.push(assert("③ 펼쳐져 있던 부모는 펼친 채 간다", r2.flash === true && r2.mOpen === true, r2));
    }

    // ── ④ 부모 부재 ─────────────────────────────────────────────────────────────
    {
      const { dash } = boot();
      ev(dash, { jobId: "C2", agentName: "orphan", threadKey: "worker:GONE", kind: "agent" });
      const orphan = btn(dash, "C2");
      // 상한으로 빠지는 부모 — 가장 오래된 끝난 카드부터 빠진다(BG_MAX).
      ev(dash, { jobId: "P4", label: "옛 매니저", threadKey: "dashboard:default", kind: "worker" });
      ev(dash, { jobId: "C4", agentName: "kid", threadKey: "worker:P4", kind: "agent" });
      ev(dash, { jobId: "P4", status: "done" });
      const whilePresent = btn(dash, "C4");
      const max = dash.run(`BG_MAX`) as number;
      for (let i = 0; i < max; i++) {
        ev(dash, { jobId: "F" + i, label: "채움 " + i, threadKey: "dashboard:default", kind: "worker" });
        ev(dash, { jobId: "F" + i, status: "done" });
      }
      const evicted = !(dash.run(`jobCards.has("P4")`) as boolean);
      const afterEvict = btn(dash, "C4");
      out.push(
        assert(
          "④ 부모 카드가 없으면(미수신) 버튼을 숨긴다 — 좌표로 이름을 지어내지 않는다",
          !orphan.shown && !orphan.text.includes("GONE"),
          orphan,
        ),
        assert(
          "★④ 부모가 끝나도 버튼은 남고, 목록 상한으로 부모 카드가 빠지면 그때 숨는다",
          whilePresent.shown && evicted && !afterEvict.shown,
          { whilePresent, evicted, afterEvict },
        ),
      );
    }

    // ── ⑤ 부모가 늦게 온다 · 새로고침(스냅샷) 경로 ─────────────────────────────────
    {
      const { dash } = boot();
      ev(dash, { jobId: "C3", agentName: "early", threadKey: "worker:M3", kind: "agent" });
      const s0 = btn(dash, "C3");
      dash.run(`handleWorkerActivity({ threadKey: "worker:M3", kind: "tool", label: "Bash", seq: 1 }, "t")`); // 활동-선도 부모(이름 없음)
      const s1 = btn(dash, "C3");
      ev(dash, { jobId: "M3", label: "늦은 매니저", threadKey: "dashboard:default", kind: "worker" });
      const s2 = btn(dash, "C3");
      const m3Label = dash.run(`jobCards.get("M3").label`) as string;
      out.push(
        assert(
          "★⑤ 부모가 없을 땐 숨김 → 이름 없는 부모 카드만 생겨도 숨김 → 라벨이 오면 «↖ <부모 라벨>» 로 나타난다",
          !s0.shown && !s1.shown && s2.shown && s2.text === "↖ " + m3Label && m3Label.includes("늦은 매니저"),
          { s0, s1, s2 },
        ),
      );
    }
    {
      const { dash } = boot();
      // 서버는 최신 먼저 준다 — 자식이 앞에 온다.
      dash.run(`applyJobsSnapshot(${J({
        jobs: [
          { jobId: "C5", agentName: "hydr", kind: "agent", threadKey: "worker:M5", ownerThreadKey: "dashboard:default", status: "running", startedAt: 2000 },
          { jobId: "M5", label: "복원 매니저", kind: "worker", threadKey: "dashboard:default", ownerThreadKey: "dashboard:default", status: "running", startedAt: 1000 },
        ],
      })}, Date.now())`);
      const h = btn(dash, "C5");
      const m = btn(dash, "M5");
      out.push(
        assert(
          "⑤ 새로고침(스냅샷)으로 복원해도 같은 결과 — 자식엔 부모 라벨 버튼, 매니저엔 없음",
          h.shown && h.text === "↖ " + (dash.run(`jobCards.get("M5").label`) as string) && !m.shown,
          { child: h, manager: m },
        ),
      );
    }
    return out;
  },
};

export default check;
