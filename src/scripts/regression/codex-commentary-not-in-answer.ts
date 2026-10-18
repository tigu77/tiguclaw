/**
 * 회귀: **중간 해설(phase:"commentary")은 사용자 답에 섞이지 않는다** (2026-10-18, 회사돌쇠 운영점검 «답변에 작성용 메모 혼입»).
 *
 * 사고: 텔레그램 답의 한국어 본문 뒤에 답변 작성·도구 순서를 논하는 영어 메모(«tool? need prompt commentary» 류)가 붙어 나갔다(gpt-6.1-sol).
 *  gpt-6 계열은 메시지마다 `phase`(`commentary`=도구 앞 중간 해설 · `final_answer`=최종 답)를 보내는데(2026-10-18 실측 — 해설 42자·최종 62자가
 *  각각 같은 `output_text.delta` 로 흘렀다), 파서는 phase 를 안 보고 한 응답의 글을 전부 이어 붙였다. OpenClaw 는 final_answer 를 고른다.
 *  ★그날 그 메모가 실제로 commentary 였는지는 원시 이벤트가 없어 미확정 — 이 검사는 **기제**를 막는다.
 * 본다(실제 Codex 어댑터 · 가짜 네트워크): 최종 답+해설 한 응답 → 최종 답만 · 해설→도구→최종 답 → 최종 답 · phase 없는 옛 응답 → 그대로 ·
 *  해설뿐인 응답 → 버리지 않는다(빈 답보다 낫다).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertIsolated, spawnWithin, type Assertion, type RegressionCheck } from "./_framework.js";

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "_codex-phase-child.ts");
const run = async (s: string): Promise<{ text?: string | null; error?: string }> => {
  const r = await spawnWithin(60_000, `codex-phase(${s})`, ["--import", "tsx", CHILD, s], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  return line === undefined ? { error: r.timedOut ? "timeout" : r.err.slice(-200) } : JSON.parse(line);
};

export const check: RegressionCheck = {
  name: "codex-commentary-not-in-answer",
  guards: "한 응답의 중간 해설(phase:commentary)이 최종 답에 이어 붙어 사용자 답에 작성용 메모가 섞이던 것 — 파서가 메시지 phase 를 안 봤다",
  run: async (): Promise<Assertion[]> => {
    assertIsolated();
    const [mixed, flow, old, only, cut, cont] = await Promise.all(
      ["answer-then-commentary", "commentary-tool-answer", "no-phase", "commentary-only", "commentary-cut-then-answer", "answer-cut-continue"].map(run),
    );
    return [
      assert("★최종 답 + 해설이 한 응답에 — 사용자 답은 최종 답만(해설 메모가 붙지 않는다)",
        mixed.text === "시안 좋네요. 이대로 진행할게요.", JSON.stringify(mixed)),
      assert("해설 → 도구 → 최종 답 — 최종 답만", flow.text === "등록된 명령은 없습니다.", JSON.stringify(flow)),
      assert("phase 없는 옛 응답은 그대로(종전 동작)", old.text === "옛 모델의 답입니다.", JSON.stringify(old)),
      assert("해설뿐인 응답은 버리지 않는다 — 빈 답보다 낫다(종전 동작)", only.text === "확인해 보겠습니다.", JSON.stringify(only)),
      assert("★해설이 흐르다 끊겨 이어 쓴 요청 — 이어받은 해설도 답에 안 붙는다", cut.text === "확인 결과 문제없습니다.", JSON.stringify(cut)),
      assert("답이 흐르다 끊겨 이어 쓴 요청 — 앞에 흘린 답은 그대로 잇는다(종전 동작)", cont.text === "앞부분 뒷부분.", JSON.stringify(cont)),
    ];
  },
};
