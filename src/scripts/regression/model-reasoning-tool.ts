/**
 * 회귀: **추론 강도 손잡이를 비서가 직접 돌릴 수 있다** — set_model_reasoning (2026-08-18).
 *
 * 사용자: *"코덱스 특정 모델 에포트 설정하려면 티구클로한테 솔 중간으로 설정해달라고 하면
 * 되나?"* → 되긴 됐다. **비서가 settings.json 을 손으로 편집하는 방식으로.** 설정을 쓰는
 * 함수는 넷이나 있었는데 전부 대시보드 엔드포인트로만 나가 있었다 — 비서에겐 한 번도 준
 * 적이 없다. 그래서 키 형식을 맞추는 것도, 옆 키를 안 날리는 것도 모델의 손끝에 달려 있었다.
 *
 * 이 검사가 지키는 것은 도구의 **존재**가 아니라 **동작**이다. 소스 grep 이 아니라
 * `applyModelReasoning` 을 격리된 홈에서 실제로 돌린다 — 전체검토(2026-08-17)의 결론
 * *"실행하는 검사만 잡는다"* 그대로.
 *
 * | 무엇을 지키나 | 안 지키면 |
 * |---|---|
 * | 짧은 이름 해석("sol"→`codex:gpt-5.6-sol`) | 사용자가 부르는 이름으로는 못 쓴다(= 도구가 없는 것과 같다) |
 * | **옆 키 보존** | 프로파일·훅이 날아간다 — 비가역이고 라우팅이 통째로 바뀐다 |
 * | 애매·미지 이름에 **안 쓴다** | 엉뚱한 모델이 조용히 무거워진다(사용자는 이유를 모른다) |
 * | **해제**가 되고 카탈로그 기본으로 복귀 | 한 번 적은 값이 영영 남는다(손잡이가 아니라 덫) |
 * | 쓴 뒤 **되읽어** 유효값 확인 | "설정했습니다" 라고 말해놓고 아무 일도 안 일어난다 |
 * | anthropic 도 같은 도구로 | 원칙 #2 위반 — 어댑터 바꾸면 무시되는 설정 |
 */
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "_model-reasoning-child.ts",
);

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "model-reasoning-"));
  const r = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
    encoding: "utf8",
    env: { ...process.env, TIGUCLAW_HOME: home },
  });
  let got: Record<string, unknown> = {};
  try {
    got = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as Record<
      string,
      unknown
    >;
  } catch {
    got = {};
  }
  const tail = (r.stderr ?? "").trim().slice(-300);

  // 자식이 아예 못 돌면 그것부터 말한다 — 조용히 0건 통과하면 검사가 아니다.
  out.push(
    assert(
      "설정 쓰기 프로브가 실제로 돌았다(빈손 통과 금지)",
      Object.keys(got).length >= 33,
      Object.keys(got).length >= 33
        ? `${Object.keys(got).length}개 판정 회수`
        : `★프로브 실패: ${tail}`,
    ),
  );
  if (Object.keys(got).length === 0) return out;

  // ── ① 짧은 이름이 풀린다 — "솔 중간으로" 가 성립하는 지점 ────────────────────
  out.push(
    assert(
      '★짧은 이름이 풀린다("sol" → codex:gpt-5.6-sol) — 사용자가 부르는 이름으로 된다',
      got.shortNameOk === true && got.shortNameResolvedKey === "medium",
      `ok=${String(got.shortNameOk)} 저장값=${String(got.shortNameResolvedKey)} · ${String(got.shortNameText)}`,
    ),
  );
  out.push(
    assert(
      "★그리고 어댑터가 읽을 유효값이 실제로 바뀐다(저장만이 아니라)",
      got.shortNameEffective === "medium",
      `유효값=${String(got.shortNameEffective)}`,
    ),
  );

  // ── ② 옆 키를 안 날린다 — 이 도구의 가장 큰 위험 ─────────────────────────────
  out.push(
    assert(
      "★손으로 넣은 다른 키가 전부 살아남는다(훅·selfDevelopment·프로파일·default·limits)",
      got.keptHooks === true &&
        got.keptSelfDev === true &&
        got.keptProfiles === true &&
        got.keptDefault === true &&
        got.keptLimits === true,
      `훅=${String(got.keptHooks)} selfDev=${String(got.keptSelfDev)} 프로파일=${String(got.keptProfiles)} default=${String(got.keptDefault)} limits=${String(got.keptLimits)}`,
    ),
  );

  // ── ③ LLM 무관 — anthropic 도 같은 도구로 ────────────────────────────────────
  out.push(
    assert(
      "★anthropic 도 같은 도구로 설정된다(원칙 #2 — 어댑터 바꿔도 같은 손잡이)",
      got.anthropicOk === true && got.anthropicEffective === "xhigh",
      `ok=${String(got.anthropicOk)} 유효값=${String(got.anthropicEffective)}`,
    ),
  );

  // ── ④ 애매하면 고르지 않고 **아무것도 안 쓴다** ──────────────────────────────
  out.push(
    assert(
      "★애매한 이름은 거절하고 후보를 전부 보여준다(엉뚱한 모델을 조용히 안 바꾼다)",
      got.ambiguousRejected === true && got.ambiguousListsAll === true,
      `거절=${String(got.ambiguousRejected)} 후보나열=${String(got.ambiguousListsAll)}`,
    ),
  );
  out.push(
    assert(
      "그리고 거절했으면 파일을 건드리지 않는다",
      got.ambiguousNoWrite === true && got.unknownNoWrite === true,
      `애매=${String(got.ambiguousNoWrite)} 미지=${String(got.unknownNoWrite)}`,
    ),
  );
  out.push(
    assert(
      "모르는 이름도 거절한다",
      got.unknownRejected === true,
      String(got.unknownRejected),
    ),
  );

  // ── ⑤ ★해제 — 끄는 길이 있고, 끄면 카탈로그 기본으로 돌아간다 ───────────────
  out.push(
    assert(
      "★해제하면 키가 사라지고 카탈로그 기본(low)으로 되돌아간다(덫이 아니라 손잡이)",
      got.clearOk === true &&
        got.clearRemovedKey === true &&
        got.clearFellBackToCatalog === "low",
      `ok=${String(got.clearOk)} 키삭제=${String(got.clearRemovedKey)} 복귀값=${String(got.clearFellBackToCatalog)}`,
    ),
  );
  out.push(
    assert(
      "빈 문자열도 해제이고, 빈 껍데기(reasoning:{})를 안 남긴다",
      got.blankIsClear === true && got.noEmptyShell === true,
      `해제=${String(got.blankIsClear)} 껍데기없음=${String(got.noEmptyShell)}`,
    ),
  );
  out.push(
    assert(
      "★섹션을 지우면서 models 자체를 날리지 않는다(가장 비싼 실수)",
      got.modelsSectionAlive === true,
      String(got.modelsSectionAlive),
    ),
  );

  // ── ⑥ ★적대 검토(2026-08-18)가 뚫은 축들 ────────────────────────────────────
  //  아래 넷은 전부 "지킨다고 적어놓고 안 지키던" 것들이다. 변이가 통과했다는 게 증거다.
  out.push(
    assert(
      "★해제가 그 키 하나만 지운다(옆 모델 설정을 통째로 날리지 않는다)",
      got.siblingsKeptOnClear === true,
      `해제 후 남은 것: ${String(got.siblingsAfterClear)}`,
    ),
  );
  out.push(
    assert(
      "★완전일치가 애매해도 되묻는다(커스텀 provider 가 같은 모델명을 가질 때)",
      got.exactAmbiguousRejected === true &&
        got.exactAmbiguousListsBoth === true &&
        got.exactAmbiguousNoWrite === true,
      `거절=${String(got.exactAmbiguousRejected)} 양쪽나열=${String(got.exactAmbiguousListsBoth)} 무쓰기=${String(got.exactAmbiguousNoWrite)}`,
    ),
  );
  out.push(
    assert(
      "★프로젝트 층이 덮으면 경고한다 — 홈에 썼는데 안 먹은 것을 성공이라 말하지 않는다",
      got.projSetWarned === true && got.projSetEffective === "max",
      `경고=${String(got.projSetWarned)} 유효값=${String(got.projSetEffective)}`,
    ),
  );
  out.push(
    assert(
      "★해제도 마찬가지 — '이제 카탈로그 기본을 따릅니다' 라고 거짓말하지 않는다",
      got.projClearNoFalseClaim === true && got.projClearWarned === true,
      `거짓주장없음=${String(got.projClearNoFalseClaim)} 경고=${String(got.projClearWarned)}`,
    ),
  );
  out.push(
    assert(
      "★그리고 정상 해제엔 그 경고가 안 뜬다(매번 뜨면 배경소음이라 아무도 안 본다)",
      got.plainClearNoWarning === true && got.plainClearSaysCatalog === true,
      `무경고=${String(got.plainClearNoWarning)} 기본복귀문구=${String(got.plainClearSaysCatalog)}`,
    ),
  );

  // ── ⑦ ★MCP 표면 — 모델이 실제로 부를 수 있는 도구인가 ───────────────────────
  //  위까지는 전부 순수 함수를 부른다. 등록을 빠뜨리거나 스키마가 깨지면 그것들은 전부
  //  초록인 채로 **도구가 없다**. 그래서 서버를 만들어 등록된 핸들러를 그대로 부른다.
  out.push(
    assert(
      "★set_model_reasoning 이 MCP 도구로 등록된다",
      got.mcpToolRegistered === true,
      `등록 도구: ${JSON.stringify(got.mcpToolNames ?? [])}`,
    ),
  );
  out.push(
    assert(
      "★그 핸들러를 부르면 실제로 유효값이 바뀐다(순수 함수만 초록인 상태 방지)",
      got.mcpCallOk === true && got.mcpCallEffective === "high",
      `ok=${String(got.mcpCallOk)} 유효값=${String(got.mcpCallEffective)}`,
    ),
  );
  out.push(
    assert(
      "도구 설명이 살아 있다(비면 모델이 언제 쓸지 모른다)",
      got.mcpHasDescription === true,
      String(got.mcpHasDescription),
    ),
  );

  return out;
};

export const check: RegressionCheck = {
  name: "model-reasoning-tool",
  guards:
    "추론 강도를 비서가 settings.json 손편집으로만 바꿀 수 있던 것 — 키 형식·옆 키 보존이 전부 모델의 손끝에 달려 있었다. set_model_reasoning 이 짧은 이름을 풀고, 옆 키를 보존하고, 애매하면 안 쓰고, 해제하면 카탈로그 기본으로 되돌리고, 쓴 뒤 되읽어 유효값을 확인하는지를 **실제로 돌려서** 본다",
  run,
};
