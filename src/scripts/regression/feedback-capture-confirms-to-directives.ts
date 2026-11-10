/**
 * 회귀: **사용자가 확인한 반응 규칙이 확정 지침에 올라가 다음 턴 프롬프트에 실린다** (2026-10-13 정태님:
 *  «좋다 잘했다, 이렇게 하지 마라 — 이걸로 교정이 되어야 진정한 비서»).
 *
 * 종전: 사용자 확정 경로(`promoteDirective`)는 **호출부 0** 이었고, 반응은 모델 재량의 메모로만 남아 매 턴 실리는
 *  자리에 닿지 않았다(설계 `docs/decisions/2026-10-13-feedback-correction.md` §1).
 *
 * 재는 것(격리 홈 · 모델 호출 0):
 *  ① 메인 대화에서 set → `SELF_GROWTH.md` 에 user 로 착지 → **프롬프트 조각에 실린다** · retire → 빠진다
 *  ② 매니저·에이전트 턴엔 도구가 닿지 않는다(확인해 줄 사용자가 없다 — `REACH` 가 정한다)
 *  ③ 상한은 **쓸 때** 거절 — 넘치는 추가는 막고, 같은 key 고침은 두 번 세지 않고, 자율(auto) 지침은 사용자 몫에 안 센다
 *  ④ 한 줄·길이·key 형식 · 없는 key retire 거절
 *  ⑥~⑨ (적대 검토 반영) 쓸 때 상한 = 실제 실림 · 동시 호출 · user 우선 선별·배치 · list·긴 자율 key 내리기·구분자 거절
 *  ⑤ 배선: 코어 서버가 도구를 내고, 스킬은 **빌트인**으로 발견되며 **메인 대화에만** 실린다,
 *     메인 칸 조립본이 실제 도구·스킬 이름을 가리키고 다른 칸 조립본은 지시하지 않는다(2026-11-10 개정)
 *
 * ★도구·스킬은 **코어 소유**다(같은 날 정태님 «플러그인인데 코어 소스에서 가리켜?») — 헌법이 가리키는 이름을
 *  플러그인이 내면, 플러그인을 끈 설치본에서 헌법이 없는 도구를 지시한다. 그래서 ⑤ 가 출처까지 잰다.
 *
 * 등급: **동작**.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "feedback-capture-confirms-to-directives",
  guards: "사용자가 «이렇게 하지 마» 라고 교정해도 다음 대화에 안 닿던 것 — 사용자 확정 경로가 호출부 0이었다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const { confirmFeedback, planFeedback, userPromptBytes, createDirectivesMcpServer, FEEDBACK_TEXT_MAX } = await import(
      "../../core/llm-runtime/capabilities/directives-mcp.js"
    );
    const { coreServerTools } = await import("../../core/llm-runtime/capabilities/_core-server.js");
    const { reaches, turnKindOf } = await import("../../core/llm-runtime/capability-reach.js");
    const { formatSelfGrowthDirectives, DIRECTIVE_INDEX_CAP_BYTES } = await import("../../core/prompt-assembly.js");
    const { upsertDirective } = await import("../../store/self-growth-md.js");
    const { discoverSkills, formatSkillIndex } = await import("../../core/llm-runtime/capabilities/skill-registry.js");

    const call = confirmFeedback;

    // ① 착지 → 실림 → 내림
    const RULE = "변경 기록을 쓸 때: 회귀-예시를 넣지 않는다";
    const set1 = await call({ key: "regr-changelog-no-examples", text: RULE });
    const promptAfterSet = formatSelfGrowthDirectives();
    const retire1 = await call({ key: "regr-changelog-no-examples", action: "retire" });
    const promptAfterRetire = formatSelfGrowthDirectives();

    // ② 닿는 칸 — 표가 정한다(어댑터가 표를 거치는지는 capability-reach-is-authority 가 잰다)
    const reach = {
      메인: reaches("directives", turnKindOf({})),
      매니저: reaches("directives", turnKindOf({ workerDepth: 1 })),
      에이전트: reaches("directives", turnKindOf({ subagentDepth: 1 })),
    };

    // ③ 상한 — 판정만(순수). 상한 근처까지 찬 사용자 지침 + auto 지침
    const long = "가".repeat(180);
    const filled = Array.from({ length: 40 }, (_, i) => ({ key: `u${String(i)}`, source: "user", text: long }));
    const fit: typeof filled = [];
    for (const d of filled) {
      if (userPromptBytes([...fit, d]) > DIRECTIVE_INDEX_CAP_BYTES) break;
      fit.push(d);
    }
    const overflow = planFeedback({ key: "regr-new", text: long }, fit);
    const sameKey = planFeedback({ key: fit[0]!.key, text: long }, fit);
    const autos = Array.from({ length: 40 }, (_, i) => ({ key: `a${String(i)}`, source: "auto", text: long }));
    const autoIgnored = planFeedback({ key: "regr-new", text: "짧은 규칙" }, autos);

    // ④ 형식
    const multi = planFeedback({ key: "regr-a", text: "한 줄\n두 줄" }, []);
    const tooLong = planFeedback({ key: "regr-a", text: "가".repeat(201) }, []);
    const badKey = planFeedback({ key: "Bad Key", text: "규칙" }, []);
    const retireMissing = planFeedback({ key: "regr-none", action: "retire" }, []);

    // ⑤ 배선
    createDirectivesMcpServer();
    const served = (coreServerTools("directives") ?? []).map((t) => t.name);
    // ★작업 폴더를 레포로 주면 같은 스킬이 «프로젝트» 출처로도 잡혀 빌트인 판정이 가려진다 — 빈 폴더로 잰다.
    const skills = await discoverSkills(mkdtempSync(path.join(tmpdir(), "regr-fc-")));
    const skill = skills.find((s) => s.name === "feedback-capture");
    const mainIdx = formatSkillIndex(skills, "main");
    const mgrIdx = formatSkillIndex(skills, "manager");
    // ★이름은 **도구가 닿는 칸의 조립본**에서 본다(2026-11-10 지침 통합 후속). 공유 sysprompt 는 모든 칸에 가므로
    //  거기 메인 전용 도구 이름을 요구하면, 그 도구가 없는 매니저·서브에게 «쓰라» 는 지시를 강요하게 된다.
    const { REGION_A_SYSTEM_PROMPT } = await import("../../core/llm-runtime/adapters/_shared-sysprompt.js");
    const { scopeConstitution } = await import("../../core/constitution-scope.js");
    const sysprompt = String(REGION_A_SYSTEM_PROMPT);
    const constitution = readFileSync(path.join(REPO, "SYSTEM.md"), "utf8");
    const roleView = (k: "main" | "manager" | "subagent"): string => {
      const s = scopeConstitution(constitution, k);
      return `${sysprompt}\n${s.body}\n${s.roleExtra}`;
    };
    const views = { 메인: roleView("main"), 매니저: roleView("manager"), 에이전트: roleView("subagent") };
    // 자율 지침이 있어도 사용자 것이 먼저 실린다(실림 순서는 user 우선)
    await upsertDirective({ key: "regr-auto", text: "회귀-자율 교훈", source: "auto" });
    await call({ key: "regr-user", text: "회귀-사용자 규칙" });
    const ordered = formatSelfGrowthDirectives();
    // ★격리 홈은 다른 검사와 같이 쓴다 — 남긴 지침이 «0건이면 비용 0» 검사를 오염시켰다(첫 실행 실측). 넣은 것은 지운다.
    const { deleteDirective } = await import("../../store/self-growth-md.js");
    const clear = async (keys: readonly string[]) => {
      for (const k of keys) await deleteDirective(k);
    };
    await clear(["regr-auto", "regr-user"]);

    // ⑥ ★상한은 **실제로 실리는 모양**으로 잰다(적대 검토 G1) — 판정 함수로 만든 목록을 판정 함수로 재면, 그 함수가
    //  틀려도 같이 틀린다(개행 몫을 빼도 초록이었다). 그래서 경계를 **싣는 쪽 출력**에서 1바이트 단위로 찾고, 판정이
    //  그 자리에서 같은 답을 내는지 본다: 실리는 최장 길이는 받고, 1바이트 더는 거절한다.
    const base = Array.from({ length: 7 }, (_, i) => ({ key: `u-base-${String(i)}`, text: "가".repeat(185) }));
    for (const d of base) await upsertDirective({ key: d.key, text: d.text, source: "user" });
    const folds = async (n: number): Promise<boolean> => {
      await upsertDirective({ key: "u-probe", text: "a".repeat(n), source: "user" });
      const folded = formatSelfGrowthDirectives().includes("건 더");
      await clear(["u-probe"]);
      return folded;
    };
    let lo = 1;
    let hi = FEEDBACK_TEXT_MAX + 1; // lo 는 안 접히고 hi 는 접힌다(아래 단언이 확인)
    const edgeKnown = !(await folds(lo)) && (await folds(hi));
    while (edgeKnown && hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await folds(mid)) hi = mid;
      else lo = mid;
    }
    const baseRows = base.map((d) => ({ ...d, source: "user" }));
    const atEdge = planFeedback({ key: "u-new", text: "a".repeat(lo) }, baseRows);
    const pastEdge = planFeedback({ key: "u-new", text: "a".repeat(lo + 1) }, baseRows);
    await clear(base.map((d) => d.key));

    // ⑦ ★동시 호출이 상한을 못 넘는다(적대 검토 F4 — codex 는 한 응답의 도구 호출을 병렬로 돈다). 한 줄 남은 자리에 둘을 동시에.
    for (const d of fit.slice(0, -1)) await upsertDirective({ key: d.key, text: d.text, source: "user" });
    const race = await Promise.all([
      call({ key: "regr-race-a", text: long }),
      call({ key: "regr-race-b", text: long }),
    ]);
    const racePrompt = formatSelfGrowthDirectives();
    await clear([...fit.map((d) => d.key), "regr-race-a", "regr-race-b"]);

    // ⑧ ★사용자 몫이 먼저 뽑히고 먼저 놓인다(적대 검토 G2·G3) — user 를 **가장 먼저** 만들고 auto 로 상한을 넘긴다.
    //  user 우선이 빠지면 고를 때는 최신(auto)에 밀려 접히고, 놓을 때는 만든 순서로 맨 뒤에 간다.
    await upsertDirective({ key: "regr-first-user", text: "회귀-먼저 만든 사용자 규칙", source: "user" });
    await new Promise((r) => setTimeout(r, 5));
    const autoKeys = Array.from({ length: 10 }, (_, i) => `regr-auto-${String(i)}`);
    for (const k of autoKeys) await upsertDirective({ key: k, text: long, source: "auto" });
    const userFirstPrompt = formatSelfGrowthDirectives();
    await clear(["regr-first-user", ...autoKeys]);

    // ⑨ key 를 볼 길 · 긴 자율 key 내리기 · 구분자 거절
    await upsertDirective({ key: "regr-listed", text: "회귀-목록 규칙", source: "user" });
    const longAutoKey = `failure_${"x".repeat(60)}`;
    await upsertDirective({ key: longAutoKey, text: "회귀-자율 실패 교훈", source: "auto" });
    const listed = await call({ action: "list" });
    const retireLong = await call({ key: longAutoKey, action: "retire" });
    // 구분자는 **하나씩** 넣어 본다 — 둘을 한 입력에 넣으면 한쪽 검사가 빠져도 다른 쪽이 거절해 초록이었다(재검토 G2).
    const markerBegin = planFeedback({ key: "regr-marker", text: "규칙 <!-- directive: x 끝" }, []);
    const markerEnd = planFeedback({ key: "regr-marker", text: "규칙 <!-- /directive --> 끝" }, []);
    const arrow = planFeedback({ key: "regr-marker", text: "배포할 때: 빌드 --> 재시작 순서를 지킨다" }, []);
    // 긴 자율 key 로 **set**(같은 취지로 고치며 사용자 몫으로 올림)도 된다 — retire 만 검사하면 set 쪽 예외가 빠져도 몰랐다(재검토 G1).
    const longAutoKey2 = `failure_${"y".repeat(60)}`;
    await upsertDirective({ key: longAutoKey2, text: "회귀-자율 교훈 2", source: "auto" });
    const setLong = await call({ key: longAutoKey2, text: "회귀-사용자가 고친 교훈" });
    const setLongPrompt = formatSelfGrowthDirectives();
    await clear(["regr-listed", longAutoKey, longAutoKey2]);

    return [
      assert(
        "★① 메인 대화에서 set 하면 user 로 착지해 프롬프트 조각에 실리고, retire 하면 빠진다",
        !set1.isError && promptAfterSet.includes(`[user] ${RULE}`) && !retire1.isError && !promptAfterRetire.includes(RULE),
        { set: set1.text, retire: retire1.text, 실림: promptAfterSet.split("\n").slice(0, 3) },
      ),
      assert(
        "★② 메인 대화에만 닿고 매니저·에이전트 턴엔 닿지 않는다",
        reach.메인 && !reach.매니저 && !reach.에이전트,
        reach,
      ),
      assert(
        "★③ 상한은 쓸 때 거절 — 넘치는 추가는 막고, 같은 key 고침은 통과, auto 지침은 사용자 몫에 안 센다",
        fit.length > 0 && !overflow.ok && sameKey.ok && autoIgnored.ok,
        { 들어간수: fit.length, 넘침: overflow.ok, 같은키: sameKey.ok, auto무시: autoIgnored.ok },
      ),
      assert(
        "④ 여러 줄·200자 초과·잘못된 key·없는 key retire 는 거절",
        !multi.ok && !tooLong.ok && !badKey.ok && !retireMissing.ok,
        { multi: multi.ok, tooLong: tooLong.ok, badKey: badKey.ok, retireMissing: retireMissing.ok },
      ),
      assert(
        "⑤ 코어 서버 directives 가 confirm_feedback 도구를 낸다",
        served.includes("confirm_feedback"),
        { 도구: served },
      ),
      assert(
        "★⑤ 스킬 feedback-capture 는 빌트인으로 발견되고 메인 대화 인덱스에만 실린다",
        skill !== undefined && skill.source === "builtin" && mainIdx.includes("feedback-capture") && !mgrIdx.includes("feedback-capture"),
        { 발견: skill?.source, 메인: mainIdx.includes("feedback-capture"), 매니저: mgrIdx.includes("feedback-capture") },
      ),
      assert(
        "★⑤ 메인 칸 조립본(sysprompt+헌법)은 실제 도구·스킬 이름을 가리키고, 도구가 닿지 않는 매니저·에이전트 조립본은 그 이름을 지시하지 않는다",
        views.메인.includes("`confirm_feedback`") && views.메인.includes("`feedback-capture`") &&
          !views.매니저.includes("confirm_feedback") && !views.에이전트.includes("confirm_feedback") &&
          !views.매니저.includes("`feedback-capture`") && !views.에이전트.includes("`feedback-capture`"),
        {
          메인도구: views.메인.includes("`confirm_feedback`"),
          메인스킬: views.메인.includes("`feedback-capture`"),
          매니저: views.매니저.includes("confirm_feedback") || views.매니저.includes("`feedback-capture`"),
          에이전트: views.에이전트.includes("confirm_feedback") || views.에이전트.includes("`feedback-capture`"),
        },
      ),
      assert(
        "⑤ 교정 보존 원칙(현재 반영 → 보존 가치 판단, 단발 교정 자동 규칙화 금지)은 모든 칸 공유 프롬프트에 있다",
        /교정은 먼저 현재 작업에 반영하고, 영속 저장은 별도로 판단/.test(sysprompt) &&
          /단발 교정·평범한 맞장구를 자동 규칙화하거나/.test(sysprompt),
        "공유 원칙",
      ),
      // 증거란에 항목별 관측값을 싣는다(suite-selfcheck: 기대값만 적은 증거 금지).
      ...(() => {
        const body = readFileSync(path.join(REPO, "skills/feedback-capture/SKILL.md"), "utf8");
        const listAt = body.search(/^## \d+\. 올리기 전에 겹치는지 본다/m);
        const setAt = body.search(/^## \d+\. 올린다/m);
        const description = /^description:\s*(.*)$/m.exec(body)?.[1] ?? "";
        const correctionRow = body.split("\n").find((l) => l.startsWith("| **분명한 교정**")) ?? "";
        // ★설명(트리거 자리)과 실제 분류 행을 **각각** 본다(R1 독립 검토) — 도입부만 보면 분류 행이 종전처럼
        //  «무조건 규칙화» 로 돌아가도 초록이었다.
        const seen = {
          설명_반영후대조: /먼저 지금 작업에 반영하고, 다음 대화에도 지켜야 할 것만 기존 지침과 대조/.test(description),
          설명_단발: /단발 교정은 반영으로 끝내/.test(description),
          분류행_먼저반영: /먼저 지금 작업에 반영한다/.test(correctionRow),
          분류행_3으로: /다시 지켜야 할 방식[^|]*3으로/.test(correctionRow),
          분류행_이번만: /이번 산출물에만 해당하면 반영으로 끝낸다/.test(correctionRow),
          본문_순서: /지금 작업에 반영 → 다음 대화에도 지킬 가치가 있나 → 기존 지침과 대조 → 필요한 것만 저장/.test(body),
          본문_단발: /단발\s*교정은 반영으로 끝낸다/.test(body),
          절_순서: listAt >= 0 && setAt > listAt,
          명시지시_AGENT: /묻지 말고 `AGENT\.md` 에 바로 반영/.test(body),
          증거만: /증거만/.test(body),
          사용자언어: /사용자가 말한 언어로/.test(body),
        };
        return [
          assert(
            "★⑤ 스킬 설명·분류 행·본문이 같은 순서(지금 반영 → 보존 가치 → 기존 대조 → 저장)를 따르고, 명시 상시 지시는 묻지 않고 AGENT.md 로·애매한 반응은 증거만·사용자 언어로 적는다",
            Object.values(seen).every(Boolean),
            JSON.stringify(seen),
          ),
        ];
      })(),
      assert(
        "⑤ 자율 지침이 있어도 사용자 확정분이 먼저 실린다",
        ordered.indexOf("회귀-사용자 규칙") >= 0 && ordered.indexOf("회귀-사용자 규칙") < ordered.indexOf("회귀-자율 교훈"),
        ordered.split("\n").slice(0, 4),
      ),
      assert(
        "★⑥ 쓸 때 판정한 상한 = 실제로 실리는 상한 — 접히지 않는 최장 길이는 받고, 1바이트 더는 거절한다",
        edgeKnown && atEdge.ok && !pastEdge.ok,
        { 경계찾음: edgeKnown, 최장: lo, 경계에서: atEdge.ok, 한바이트더: pastEdge.ok },
      ),
      assert(
        "★⑦ 한 줄 남은 자리에 동시에 둘을 올리면 하나만 들어가고 프롬프트는 안 접힌다",
        race.filter((r) => !r.isError).length === 1 && !racePrompt.includes("건 더"),
        { 성공: race.filter((r) => !r.isError).length, 접힘: racePrompt.includes("건 더") },
      ),
      assert(
        "★⑧ 자율 지침이 상한을 넘겨도 먼저 만든 사용자 규칙이 실리고 맨 앞에 놓인다",
        (() => {
          const u = userFirstPrompt.indexOf("회귀-먼저 만든 사용자 규칙");
          const a = userFirstPrompt.indexOf("[auto]");
          return u >= 0 && a > u && userFirstPrompt.includes("건 더");
        })(),
        userFirstPrompt.split("\n").slice(0, 3),
      ),
      assert(
        "⑨ list 가 key 를 보여 주고, 형식보다 긴 자율 지침 key 도 내리고·고칠 수 있고, 파일 구분자는 각각 거절하되 평범한 화살표는 받는다",
        listed.text.includes("regr-listed") && listed.text.includes(longAutoKey) && !retireLong.isError &&
          !setLong.isError && setLongPrompt.includes("[user] 회귀-사용자가 고친 교훈") &&
          !markerBegin.ok && !markerEnd.ok && arrow.ok,
        {
          list: listed.text.split("\n").slice(0, 3),
          긴key내림: retireLong.text,
          긴key고침: setLong.text,
          시작구분자: markerBegin.ok,
          끝구분자: markerEnd.ok,
          화살표: arrow.ok,
        },
      ),
    ];
  },
};

export default check;
