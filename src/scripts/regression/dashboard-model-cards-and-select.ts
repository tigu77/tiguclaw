/**
 * 회귀: **모델 화면 폴링이 열린 색 피커를 닫지 않는다** + **채팅 모델 드롭다운은 저장이 실패하면 되돌린다**
 * (2026-10-09 전체 적대 검토).
 *
 * ── ① 30초 폴링 ──────────────────────────────────────────────────────────
 *  activity.js 가 30초마다 `fetchModelProfiles` 를 부르고, `renderModelProfiles` 는 매번 카드를 **통째로** 다시
 *  만들었다 — 바뀐 게 없어도. 그래서 색을 고르는 중이던 피커가 닫혔다(미리보기도 사라진다). 고침: 인벤토리 목록과
 *  같은 `dataset.sig` — 그릴 것이 같으면 건너뛴다. ★오류 문구로 바뀐 뒤엔 표식을 지워야 한다(안 지우면 다음 성공이
 *  «같다» 고 보고 오류 문구를 남긴다) — 이 검사가 그 경로도 밟는다.
 *
 * ── ② 드롭다운 실패 ──────────────────────────────────────────────────────
 *  고르면 탭 상태를 먼저 바꾸고(낙관) 저장하는데, 실패하면 토스트만 띄우고 **그대로 뒀다** — 서버는 옛 프로파일로
 *  도는데 화면은 새 이름이었다. 고침: 실패하면 되돌린다. ★단 그 사이 다른 값을 또 골랐으면 건드리지 않는다
 *  (늦게 온 실패가 새 선택을 지우면 그게 새 결함이다).
 *
 * 등급: **동작** — 진짜 view-models.js·model-select.js 를 부팅 순서대로 싣는다.
 */
import { bootDashboard, dashSource, dispatch, jsonResponse, makeClock, makeEvent, type MElement } from "./_mini-dom.js";
import { assert, i18nForContext, type Assertion, type RegressionCheck } from "./_framework.js";

const profiles = (color: string) => ({
  profiles: [
    { name: "default", isDefault: true, pool: ["codex:gpt-x"] },
    { name: "fast", color, pool: ["codex:gpt-y"] },
    { name: "slow", pool: ["claude:z"] },
  ],
});

export const check: RegressionCheck = {
  name: "dashboard-model-cards-and-select",
  guards:
    "30초 폴링이 모델 카드를 통째로 다시 만들어 열린 색 피커가 닫히던 것 + 채팅 모델 드롭다운이 저장 실패 뒤에도 고른 값에 남아 화면과 실제가 갈리던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];

    // ── ① 모델 카드 ───────────────────────────────────────────────────────
    {
      const clock = makeClock();
      let reply: { body: unknown; status: number } = { body: profiles("#ff0000"), status: 200 };
      const dash = bootDashboard({
        clock,
        i18n: i18nForContext,
        fetch: async (url: string) =>
          url.startsWith("/api/model-profiles") ? jsonResponse(reply.body, reply.status) : jsonResponse({}, 404),
        stubs: "const setChatPanel = () => {};",
      });
      const root = dash.document.getElementById("detail-panel") as MElement;
      dash.run("showModels()");
      dash.run("fetchModelProfiles()");
      await clock.advance(5);
      const picker0 = root.querySelectorAll(".model-color-input")[1];
      if (picker0) picker0.value = "#00ff00"; // 고르는 중(아직 change 전)
      dash.run("fetchModelProfiles()"); // 30초 폴링 — 바뀐 것 없음
      await clock.advance(5);
      const picker1 = root.querySelectorAll(".model-color-input")[1];
      out.push(
        assert(
          "★★바뀐 게 없는 폴링은 카드를 다시 만들지 않는다 — 고르던 색 피커가 **같은 노드·같은 값**으로 남는다",
          picker0 !== undefined && picker1 === picker0 && picker1.value === "#00ff00",
          `같은 노드=${String(picker1 === picker0)} 값=${picker1?.value ?? "(없음)"}`,
        ),
      );
      reply = { body: profiles("#0000ff"), status: 200 };
      dash.run("fetchModelProfiles()");
      await clock.advance(5);
      const picker2 = root.querySelectorAll(".model-color-input")[1];
      out.push(
        assert(
          "★그래도 **바뀌면** 다시 그린다(다른 곳에서 바꾼 색이 들어온다)",
          picker2 !== undefined && picker2 !== picker0 && picker2.value === "#0000ff",
          `새 노드=${String(picker2 !== picker0)} 값=${picker2?.value ?? "(없음)"}`,
        ),
      );
      reply = { body: { error: "down" }, status: 500 };
      dash.run("fetchModelProfiles()");
      await clock.advance(5);
      const errShown = root.querySelectorAll(".model-card").length === 0;
      reply = { body: profiles("#0000ff"), status: 200 };
      dash.run("fetchModelProfiles()");
      await clock.advance(5);
      const cardsBack = root.querySelectorAll(".model-card").length;
      out.push(
        assert(
          "★오류 뒤 같은 목록이 다시 오면 카드가 **돌아온다**(오류로 바꾼 뒤 «같은 그림» 표식을 지운다)",
          errShown && cardsBack === 3,
          `오류 때 카드 0개=${String(errShown)} · 복구 뒤 카드 ${cardsBack}개`,
        ),
      );
      out.push(assert("모델 화면에서 던진 것이 없다", clock.errors.length === 0, clock.errors.join(" | ") || "예외 0"));
    }

    // ── ② 채팅 모델 드롭다운 ──────────────────────────────────────────────
    {
      const clock = makeClock();
      const saves: Array<{ profile: string; resolve: (status: number) => void }> = [];
      const dash = bootDashboard({
        clock,
        i18n: i18nForContext,
        ids: ["chat-model-select"],
        fetch: (url: string, init?: { body?: string }) => {
          if (url.startsWith("/api/model-profiles")) return Promise.resolve(jsonResponse(profiles("#ff0000")));
          if (url.startsWith("/api/set-session-profile"))
            return new Promise((res) => {
              const profile = (JSON.parse(init?.body ?? "{}") as { profile: string }).profile;
              saves.push({ profile, resolve: (status) => res(jsonResponse(status === 200 ? { ok: true } : { error: "nope" }, status)) });
            });
          return Promise.resolve(jsonResponse({}, 404));
        },
        stubs: 'let openTabs = [{ threadKey: "dashboard:default", modelProfile: null }]; activeThreadKey = "dashboard:default";',
      });
      dash.run(dashSource("model-select.js"), "model-select.js");
      await clock.advance(5);
      const sel = dash.document.getElementById("chat-model-select") as MElement;
      const pick = (v: string): void => {
        sel.value = v;
        dispatch(sel, makeEvent("change", { bubbles: true }));
      };
      const tab = (): unknown => dash.run("openTabs[0].modelProfile");

      pick("fast");
      await clock.advance(1);
      const optimistic = tab();
      saves.shift()?.resolve(500);
      await clock.advance(5);
      out.push(
        assert(
          "★★저장이 **실패하면** 드롭다운과 탭 상태가 원래 값(기본)으로 돌아간다",
          optimistic === "fast" && sel.value === "" && tab() === null,
          `고른 즉시 탭=${String(optimistic)} → 실패 뒤 드롭다운=${JSON.stringify(sel.value)} 탭=${String(tab())}`,
        ),
      );

      // ★요청은 줄을 선다 — 동시에 보내면 응답 순서가 서버 적용 순서라는 보장이 없다(2026-10-10 아스트라 검토).
      pick("fast");
      await clock.advance(1);
      pick("slow");
      await clock.advance(1);
      const queued = saves.length; // 앞 요청이 안 끝났으면 뒤 요청은 아직 안 나간다
      saves.shift()?.resolve(500); // 옛 선택(fast) 실패
      await clock.advance(5);
      const whilePending = { sel: sel.value, tab: tab() }; // 더 최신 선택(slow)이 가는 중 — 지우면 안 된다
      saves.shift()?.resolve(200); // 새 선택(slow) 성공
      await clock.advance(5);
      out.push(
        assert(
          "★옛 선택의 실패는 가는 중인 새 선택을 지우지 않고, 요청은 줄을 선다(한 번에 하나)",
          queued === 1 && whilePending.sel === "slow" && whilePending.tab === "slow" && sel.value === "slow" && tab() === "slow",
          { 동시요청: queued, 실패직후: whilePending, 끝: { 드롭다운: sel.value, 탭: tab() } },
        ),
      );

      // 반대 조합 — A 성공 뒤 B 실패: 화면은 서버가 받아들인 마지막 값(A)이다(종전엔 기본값으로 갔는데 서버는 A 였다)
      pick("");
      await clock.advance(1);
      saves.shift()?.resolve(200);
      await clock.advance(5);
      pick("fast");
      await clock.advance(1);
      pick("slow");
      await clock.advance(1);
      saves.shift()?.resolve(200); // fast 성공
      await clock.advance(5);
      saves.shift()?.resolve(500); // slow 실패
      await clock.advance(5);
      out.push(
        assert(
          "★A 성공 → B 실패면 화면은 서버가 받아들인 A 다(화면과 서버가 갈리지 않는다)",
          sel.value === "fast" && tab() === "fast",
          { 드롭다운: sel.value, 탭: tab() },
        ),
      );

      // 서버 동기화(다른 기기·새로고침)로 탭 값이 바뀐 뒤의 실패는 **그 값**으로 되돌린다(옛 기준값 X — 재검토 #7)
      dash.run('openTabs[0].modelProfile = "slow"; window.hydrateModelSelect();');
      await clock.advance(1);
      pick("");
      await clock.advance(1);
      saves.shift()?.resolve(500);
      await clock.advance(5);
      out.push(
        assert(
          "서버 동기화로 바뀐 탭 값이 되돌림의 기준이다(낡은 확정값으로 가지 않는다)",
          sel.value === "slow" && tab() === "slow",
          { 드롭다운: sel.value, 탭: tab() },
        ),
      );
      out.push(assert("드롭다운에서 던진 것이 없다", clock.errors.length === 0, clock.errors.join(" | ") || "예외 0"));
    }
    return out;
  },
};
