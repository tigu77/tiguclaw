/**
 * `profile-pool-reasoning` 의 자식 프로세스 — 격리된 홈에서 **실물 해석기·쓰기 함수**를 돌린다.
 *
 * ★자식인 이유: `getPaths()` 는 첫 호출에 홈을 **동결**한다(`cached`). 스위트 프로세스는
 *  이미 그 지점을 지난 뒤라 같은 프로세스에선 격리 홈을 만들 수 없다 — 그러면 검사가 실제
 *  홈의 settings.json 을 고치거나(비가역) 아무것도 안 하고 초록이 된다.
 *  (`_model-reasoning-child` 와 같은 형태. 그 파일 주석이 이 함정을 이미 적어뒀다.)
 *
 * 결과를 마지막 줄 JSON 으로 낸다.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const home = process.env.TIGUCLAW_HOME ?? "";
const settingsFile = path.join(home, "settings.json");
const read = (): Record<string, any> =>
  JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, any>;

mkdirSync(home, { recursive: true });
writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      // 옆 키 — 쓰기가 이걸 날리면 안 된다(프로파일이 사라지면 라우팅이 통째로 바뀐다).
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
      models: {
        default: "high",
        // ★같은 모델이 두 프로파일에 **다른 강도**로 — 이 기능이 없으면 표현 불가능했던 모양.
        profiles: {
          high: {
            pool: ["codex:gpt-5.6-sol", { model: "anthropic:claude-opus-5", reasoning: "max" }],
          },
          quick: { pool: [{ model: "anthropic:claude-opus-5", reasoning: "low" }] },
        },
        // 전역 — 프로파일이 안 덮은 곳에서만 이겨야 한다.
        reasoning: { "anthropic:claude-opus-5": "medium" },
      },
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

const out: Record<string, unknown> = {};
try {
  const { loadModelProfiles, setProfilePoolReasoning } = await import("../../core/settings.js");
  const { resolveModelChain, resolveModelSpecs } = await import(
    "../../core/llm-runtime/index.js"
  );
  const { applyModelReasoning } = await import(
    "../../core/llm-runtime/capabilities/model-settings-mcp.js"
  );

  // ① 파싱 — 문자열·객체 혼용이 한 모양으로.
  const profs = loadModelProfiles(home);
  const hp = profs.high?.pool ?? [];
  out.parsedShape =
    hp.length === 2 &&
    hp[0]?.spec === "codex:gpt-5.6-sol" &&
    hp[0]?.reasoning === undefined &&
    hp[1]?.spec === "anthropic:claude-opus-5" &&
    hp[1]?.reasoning === "max";

  // ② 운반 — 문자열 왕복(`join(",")`)이 남아 있으면 여기서 죽는다.
  const highOpus = resolveModelChain("high", home)[0]?.find((s) => s.model === "claude-opus-5");
  const quickOpus = resolveModelChain("quick", home)[0]?.find((s) => s.model === "claude-opus-5");
  const highSol = resolveModelChain("high", home)[0]?.find((s) => s.model === "gpt-5.6-sol");
  out.carriedHigh = highOpus?.reasoning ?? null;
  out.carriedQuick = quickOpus?.reasoning ?? null;
  out.uncoveredIsUndefined = highSol?.reasoning === undefined;
  // ★**메인 턴 경로**도 같이 본다 — 여기가 제일 자주 지나는 자리인데 다른 함수를 탄다
  //  (`resolveModelSpecs` → 기본 프로파일). 한쪽만 검사하면 다른 쪽에서 조용히 죽는다.
  out.mainTurn =
    resolveModelSpecs(undefined, home).find((s) => s.model === "claude-opus-5")?.reasoning ?? null;

  // ③ 비서 경로 — 프로파일 지정 쓰기가 그 프로파일에만.
  // 전역은 medium 이다 — **다른 값**을 써야 "어느 층이 이기나" 안내가 성립한다.
  const r1 = applyModelReasoning({ model: "opus", effort: "high", profile: "quick", cwd: home });
  const a1 = loadModelProfiles(home);
  out.toolOk = r1.ok;
  out.toolText = r1.text;
  out.quickAfter = a1.quick?.pool[0]?.reasoning ?? null;
  out.highUntouched = a1.high?.pool[1]?.reasoning ?? null;
  out.globalUntouched = read().models?.reasoning?.["anthropic:claude-opus-5"] ?? null;
  out.hooksKept = Array.isArray(read().hooks?.PreToolUse);

  // ④ 해제 = 문자열 환원(빈 껍데기 금지).
  setProfilePoolReasoning("quick", "anthropic:claude-opus-5", undefined);
  out.clearedToString = read().models?.profiles?.quick?.pool?.[0] === "anthropic:claude-opus-5";

  // ⑤ 없는 대상엔 안 쓴다 + 도구가 그 사실을 말한다.
  out.noProfileWrite = setProfilePoolReasoning("없는프로파일", "anthropic:claude-opus-5", "low");
  out.noModelWrite = setProfilePoolReasoning("high", "없는:모델", "low");
  const r2 = applyModelReasoning({ model: "opus", effort: "low", profile: "없는프로파일", cwd: home });
  out.toolRefuses = r2.ok === false;

  // ⑥ 프로파일 미지정 = 종전대로 전역.
  applyModelReasoning({ model: "sol", effort: "high", cwd: home });
  out.globalStillWorks = read().models?.reasoning?.["codex:gpt-5.6-sol"] ?? null;
} catch (e) {
  out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
console.log(JSON.stringify(out));
