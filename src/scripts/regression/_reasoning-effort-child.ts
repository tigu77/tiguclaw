/**
 * 자식 프로세스 — `TIGUCLAW_HOME` 을 **프로세스 시작 시점에** 잡아야 카탈로그 캐시 경로가
 * 그리로 간다(getPaths 는 캐시라 부모 안에서 바꿔봐야 안 먹는다 — 벤치 하네스가 store 를
 * import *전에* 홈을 세팅하는 것과 같은 이유).
 *
 * 부모(reasoning-effort-from-catalog)가 임시 홈·프로젝트를 깔고 이 파일을 spawn 해서,
 * **우선순위가 실제로 어떻게 풀리는지**를 JSON 한 줄로 받아 판정한다.
 */
import { resolveReasoningEffort } from "../../core/llm-runtime/model-catalog.js";

const proj = process.argv[2] ?? process.cwd();
const home = process.argv[3] ?? process.cwd();
process.stdout.write(
  JSON.stringify({
    // 카탈로그만 있는 경우(덮어쓰기 없는 폴더를 cwd 로)
    catalogOnly: resolveReasoningEffort("codex", "gpt-5.6-sol", home) ?? null,
    // 같은 모델에 사용자 덮어쓰기가 있는 프로젝트
    overridden: resolveReasoningEffort("codex", "gpt-5.6-sol", proj) ?? null,
    // anthropic 은 카탈로그에도 없고 지어내지도 않는다
    anthropic: resolveReasoningEffort("anthropic", "claude-opus-5", home) ?? null,
    // 모르는 모델
    unknown: resolveReasoningEffort("codex", "gpt-9-future", home) ?? null,
    // ★캐시에 든 **쓰레기 값**(숫자·객체·null)이 새어 나오나 (적대 검토 B1).
    //  settings 쪽은 문자열만 통과시키는데 디스크 캐시는 무검증이었다.
    junkNum: resolveReasoningEffort("codex", "junk-num", home) ?? null,
    junkObj: resolveReasoningEffort("codex", "junk-obj", home) ?? null,
    junkNull: resolveReasoningEffort("codex", "junk-null", home) ?? null,
    // ★빈 문자열·공백 (적대 검토 F8) — settings 픽스처엔 `""` 가 있는데 카탈로그엔 없어서,
    //  "같은 판정으로 통일했다" 는 말이 절반만 참이었다. 같은 입력을 양쪽에 넣는다.
    junkEmpty: resolveReasoningEffort("codex", "junk-empty", home) ?? null,
    junkBlank: resolveReasoningEffort("codex", "junk-blank", home) ?? null,
    // ★홈 vs 프로젝트 우선순위 (적대 검토 B2) — 같은 키를 양쪽에 두면 프로젝트가 이겨야 한다.
    layered: resolveReasoningEffort("codex", "gpt-5.6-terra", proj) ?? null,
  }),
);
