/**
 * 회귀: **백그라운드 패널의 상태 필터 줄은 공통 스크롤 칸 윗변에 남고, 카드 이동은 그 줄 아래로 간다** (2026-10-30).
 *
 * 사고(정태님 모바일 신고 «스크롤영역 상단이 겹치네»): v0.79.0 에서 작업·셸 목록의 바깥 세로 스크롤을 `#bg-scroll`
 *  하나로 합치면서 묶음별 상태 필터(`진행 중 | 완료`)가 스크롤 내용에 실렸다. 목록을 조금만 올려도 그 줄이 칸 윗변
 *  (= 범위 토글 `현재 세션 | 전체 세션` 바로 밑)에서 반쯤 잘려, 같은 모양의 두 버튼 줄이 겹쳐 보였다.
 *  헤드리스 모바일(390×480, 합성 잡) 재현: 49px 올리면 필터 윗변 77.9 < 칸 윗변 94.9 — 17px 가려짐. v0.79 직전 판은
 *  필터가 스크롤 밖이라 같은 조작에서 안 잘렸다.
 *
 * 지키는 것:
 *  ① `#bg-scroll` 안의 상태 필터 전부(마크업에서 뽑는다)에 sticky·top:0·배경·양의 z-index 를 주는 규칙이 실제로 맞는다.
 *  ② 카드로 이동(`focusBgJob`·위젯 «그 카드로»)하면 카드 윗변이 **그 묶음의 필터 줄 아래** + 8px 에 선다
 *     (sticky 줄이 칸 윗변을 덮으므로, 종전 «칸 윗변 + 8px» 이면 카드 머리가 필터 밑에 숨는다). 셸도 같다.
 *
 * 등급: ① 배선 린트(CSS 선택자를 실제 마크업에 맞춰 본다 — 캐스케이드·픽셀은 노드에서 못 잰다. 픽셀은 헤드리스로
 *  확인했다) · ② 동작(미니 DOM, 위치 함수만 끼운다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";
import { bootBgPanel } from "./_bg-panel-fixture.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "bg-filter-stays-at-scroll-top",
  guards: "공통 스크롤로 합친 뒤 상태 필터 줄이 스크롤에 실려 범위 토글 밑에서 잘려 겹쳐 보이던 것 · 고정된 필터 밑에 이동한 카드 머리가 숨는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { R, clock } = bootBgPanel();

    // ① 마크업의 필터마다 sticky 규칙이 맞는가 — 규칙 선택자를 실제 요소에 matches 로 대 본다(이름 목록 없음).
    {
      const css = readFileSync(path.join(REPO, "packages/dashboard/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim().replace(/\s+/g, " "), body: m[2]! }));
      const decl = (body: string, prop: string): string | undefined => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();
      // 카드가 그 밑을 지나가므로 **위에 그려져야** 눌린다 — 양의 z-index(GPT 검토 R1: z-index 를 -1 로 바꾼 변이가 통과했다).
      const sticky = rules.filter((r) => decl(r.body, "position") === "sticky" && /^0(px)?$/.test(decl(r.body, "top") ?? "") &&
        !/^(transparent|none)$/.test(decl(r.body, "background") ?? decl(r.body, "background-color") ?? "transparent") &&
        /^[1-9]\d*$/.test(decl(r.body, "z-index") ?? ""));
      const filters = R(`[...document.getElementById("bg-scroll").querySelectorAll(".bg-filter")].map((e) => e.id)`) as string[];
      const covered = filters.map((id) => ({
        id,
        rule: sticky.find((r) => r.sel.split(",").some((s) => {
          try { return R(`document.getElementById(${JSON.stringify(id)}).matches(${JSON.stringify(s.trim())})`) === true; } catch { return false; }
        }))?.sel ?? null,
      }));
      const scopeSticky = sticky.some((r) => r.sel.split(",").some((s) => {
        try { return R(`document.getElementById("bg-scope-filter").matches(${JSON.stringify(s.trim())})`) === true; } catch { return false; }
      }));
      out.push(assert(
        "★공통 스크롤 칸 안의 상태 필터(마크업에서 뽑음 — 작업·셸)마다 sticky·top:0·배경·양의 z-index 규칙이 맞는다 · 칸 밖 범위 토글엔 안 걸린다",
        filters.length >= 2 && covered.every((c) => c.rule !== null) && !scopeSticky,
        { filters: covered, scopeSticky },
      ));
    }

    // ② 카드 이동: 카드 윗변 = 칸 윗변 + 그 묶음 필터 높이 + 8 (칸 윗변 100, 카드 문서 위치 600)
    {
      R(`handleWorkerEvent({ jobId: "a", status: "running", kind: "worker", label: "a", task: "할 일", threadKey: "dashboard:default", ownerThreadKey: "dashboard:default" }, "")`);
      R(`(() => { const s = document.getElementById("bg-scroll"); s.scrollTop = 0;
        document.getElementById("bg-filter").rect = { top: 100, bottom: 140, left: 0, right: 400, width: 400, height: 40 };
        document.getElementById("bg-shells-filter").rect = { top: 100, bottom: 136, left: 0, right: 400, width: 400, height: 36 };
        jobCards.get("a").el.getBoundingClientRect = () => ({ top: 600 - s.scrollTop, bottom: 700 - s.scrollTop, height: 100, left: 0, right: 400, width: 400 }); })()`);
      R(`window.focusBgJob("a")`);
      await clock.advance(50);
      const job = R(`document.getElementById("bg-scroll").scrollTop`) as number;

      // 셸 — 위젯 경로(펼치지 않음). 렌더가 노드를 새로 만들 수 있어 위치 함수는 셸 카드 프로토타입에서 준다.
      R(`(() => { const s = document.getElementById("bg-scroll"); s.scrollTop = 0;
        upsertShellEntry("sh", { command: "sleep 1", status: "running", threadKey: "dashboard:default", ownerTk: "dashboard:default" }, { visible: true }); renderShellsView();
        const proto = Object.getPrototypeOf(document.createElement("div")); const orig = proto.getBoundingClientRect;
        proto.getBoundingClientRect = function () {
          if (this.classList && this.classList.contains("shell-card")) return { top: 900 - s.scrollTop, bottom: 1000 - s.scrollTop, height: 100, left: 0, right: 400, width: 400 };
          return orig.call(this);
        }; })()`);
      R(`window.dispatchEvent(new CustomEvent("tigu:reveal", { detail: { kind: "shell", id: "sh" } }))`);
      await clock.advance(50);
      const shell = R(`document.getElementById("bg-scroll").scrollTop`) as number;
      out.push(assert(
        "★★카드로 이동하면 카드 윗변이 그 묶음 필터 줄 아래 + 8px 에 선다 — 작업 600−100−40−8=452 · 셸 900−100−36−8=756(필터를 빼먹으면 492·792 — 머리가 고정 줄 밑에 숨는다 · 다른 묶음 필터를 재면 셸 752)",
        job === 452 && shell === 756,
        { job, shell },
      ));
    }
    return out;
  },
};

export default check;
