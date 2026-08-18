/**
 * `model-reasoning-tool` 의 자식 프로세스 — **도구가 하는 일을 실제로 시킨다**.
 *
 * ★자식으로 도는 이유: `getPaths()` 는 첫 호출에 홈을 **동결**하고(`cached`), 모델 카탈로그도
 *  프로세스당 한 번만 디스크를 읽는다(`loadedFromDisk`). 스위트 프로세스는 이미 둘 다
 *  지난 뒤라, 같은 프로세스에서는 격리된 홈을 만들 수가 없다 — 그러면 검사가 실제 홈의
 *  settings.json 을 고치거나(비가역), 아무것도 안 하고 초록이 된다. `data-safety` 와 같은 형태.
 *
 * 결과를 마지막 줄 JSON 으로 낸다. 부모가 그것만 읽는다.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const home = process.env.TIGUCLAW_HOME ?? "";
const settingsFile = path.join(home, "settings.json");
const readSettings = (): Record<string, any> =>
  JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, any>;

// ── 픽스처: 홈 settings + 모델 카탈로그 ────────────────────────────────────────
// ★손으로 넣은 다른 키를 픽스처에 **반드시 넣는다** — 이 도구의 가장 큰 위험은 강도를
//  잘못 적는 게 아니라 **옆 키를 날리는 것**이다(프로파일이 사라지면 라우팅이 통째로 바뀐다).
mkdirSync(home, { recursive: true });
writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] },
      selfDevelopment: { enabled: false },
      models: {
        default: "high",
        profiles: {
          high: { pool: ["codex:gpt-5.6-sol", "anthropic:claude-opus-5"] },
          mid: { pool: ["codex:gpt-5.6-terra"] },
        },
        limits: { "codex:gpt-5.6-sol": { maxInputChars: 600000 } },
      },
    },
    null,
    2,
  ),
  "utf8",
);
// 카탈로그: 실제 형태 그대로(백엔드가 내려주는 default_reasoning_level 포함).
writeFileSync(
  path.join(home, "model-catalog.json"),
  JSON.stringify({
    fetchedAt: Date.now(),
    models: {
      codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      anthropic: ["claude-opus-5", "claude-sonnet-5"],
    },
    reasoning: { "codex:gpt-5.6-sol": "low", "codex:gpt-5.6-terra": "medium" },
  }),
  "utf8",
);

const { applyModelReasoning } = await import(
  "../../core/llm-runtime/capabilities/model-settings-mcp.js"
);
const { resolveReasoningEffort } = await import(
  "../../core/llm-runtime/model-catalog.js"
);

// cwd = 프로젝트 층이 없는 임시 위치(홈 층만 보게 한다).
const cwd = home;
const out: Record<string, unknown> = {};

// ── ① 짧은 이름이 풀린다 — "솔 중간으로" 가 되는 지점 ─────────────────────────
{
  const r = applyModelReasoning({ model: "sol", effort: "medium", cwd });
  const s = readSettings();
  out.shortNameOk = r.ok;
  out.shortNameResolvedKey = s.models?.reasoning?.["codex:gpt-5.6-sol"];
  // ★쓰기만 보지 않는다 — **어댑터가 실제로 읽을 값**이 바뀌었나가 판정이다.
  out.shortNameEffective = resolveReasoningEffort("codex", "gpt-5.6-sol", cwd);
  out.shortNameText = r.text.split("\n")[0];
}

// ── ② 옆 키를 안 날린다 ────────────────────────────────────────────────────────
{
  const s = readSettings();
  out.keptHooks = s.hooks?.PreToolUse?.[0]?.matcher === "Bash";
  out.keptSelfDev = s.selfDevelopment?.enabled === false;
  out.keptProfiles = s.models?.profiles?.high?.pool?.[0] === "codex:gpt-5.6-sol";
  out.keptDefault = s.models?.default === "high";
  out.keptLimits = s.models?.limits?.["codex:gpt-5.6-sol"]?.maxInputChars === 600000;
}

// ── ③ 다른 provider 도 같은 도구로 — LLM 무관(원칙 #2) ────────────────────────
{
  const r = applyModelReasoning({ model: "claude-opus-5", effort: "xhigh", cwd });
  out.anthropicOk = r.ok;
  out.anthropicEffective = resolveReasoningEffort("anthropic", "claude-opus-5", cwd);
}

// ── ④ 애매하면 **고르지 않는다** — 그리고 아무것도 안 쓴다 ────────────────────
//  엉뚱한 모델의 강도를 바꾸는 건 조용한 오답이다(사용자는 왜 느려졌는지 모른다).
{
  const before = JSON.stringify(readSettings());
  const r = applyModelReasoning({ model: "gpt-5.6", effort: "high", cwd });
  out.ambiguousRejected = !r.ok;
  out.ambiguousListsAll =
    r.text.includes("gpt-5.6-sol") &&
    r.text.includes("gpt-5.6-terra") &&
    r.text.includes("gpt-5.6-luna");
  out.ambiguousNoWrite = JSON.stringify(readSettings()) === before;
}

// ── ⑤ 모르는 이름도 거절 + 무쓰기 ─────────────────────────────────────────────
{
  const before = JSON.stringify(readSettings());
  const r = applyModelReasoning({ model: "존재하지-않는-모델", effort: "high", cwd });
  out.unknownRejected = !r.ok;
  out.unknownNoWrite = JSON.stringify(readSettings()) === before;
}

// ── ⑥ ★해제가 된다 — 그리고 카탈로그 기본으로 **되돌아간다** ──────────────────
//  끄는 길이 없으면 손잡이가 아니라 덫이다. 되돌아간 값이 카탈로그 기본(low)인지까지 본다.
{
  const r = applyModelReasoning({ model: "codex:gpt-5.6-sol", cwd });
  const s = readSettings();
  out.clearOk = r.ok;
  out.clearRemovedKey = s.models?.reasoning?.["codex:gpt-5.6-sol"] === undefined;
  out.clearFellBackToCatalog = resolveReasoningEffort("codex", "gpt-5.6-sol", cwd);
}

// ── ⑦ 빈 문자열도 해제다(생략과 같은 뜻) + 빈 껍데기를 안 남긴다 ──────────────
{
  applyModelReasoning({ model: "anthropic:claude-opus-5", effort: "   ", cwd });
  const s = readSettings();
  out.blankIsClear = s.models?.reasoning === undefined;
  out.noEmptyShell = !JSON.stringify(s).includes('"reasoning":{}');
  // 섹션을 지우면서 models 자체를 날리지 않았나(가장 비싼 실수).
  out.modelsSectionAlive = s.models?.profiles?.high !== undefined;
}

// ── ⑧ ★MCP 표면까지 — **도구로서 실제로 불린다** ──────────────────────────────
//  위 ①~⑦ 은 순수 함수를 부른다. 그건 판정을 지키지만 "모델이 이걸 도구로 쓸 수 있나" 는
//  안 지킨다 — 등록을 빠뜨리거나 스키마가 깨지면 전부 초록인 채로 도구가 없다.
//  그래서 서버를 만들어 **등록된 핸들러를 그대로 호출**한다.
{
  const { createModelSettingsMcpServer } = await import(
    "../../core/llm-runtime/capabilities/model-settings-mcp.js"
  );
  const srv = createModelSettingsMcpServer(cwd) as unknown as {
    instance: { _registeredTools: Record<string, any> };
  };
  const reg = srv.instance._registeredTools;
  const t = reg["set_model_reasoning"];
  out.mcpToolRegistered = t !== undefined;
  out.mcpToolNames = Object.keys(reg);
  if (t !== undefined) {
    const r = await t.handler({ model: "terra", effort: "high" }, {});
    out.mcpCallOk = r?.isError !== true;
    out.mcpCallEffective = resolveReasoningEffort("codex", "gpt-5.6-terra", cwd);
    // 스키마가 살아 있나 — 설명이 비면 모델은 이 도구를 언제 쓸지 모른다.
    out.mcpHasDescription = typeof t.description === "string" && t.description.length > 100;
  }
}

process.stdout.write(`\n${JSON.stringify(out)}\n`);
