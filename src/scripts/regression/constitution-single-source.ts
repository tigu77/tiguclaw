/**
 * 회귀: **행동 판단은 조립된 프롬프트 전체에 정확히 한 번만 있다** (2026-08-05).
 *
 * 사고: 헌법이 **두 벌**이었다 — 어댑터 sysprompt(18.3KB)와 `SYSTEM.md`(17.7KB)가 같은 주제를
 * 각자 진술했고, 그 사이가 **갈려 있었다**:
 *   - 앱 소스 수정: `SYSTEM.md` "플래그 켜져 있으면 한다" ↔ sysprompt "거절하라"(조건 없음).
 *     이 인스턴스는 플래그가 `true` 였으니 비서는 정반대 지시를 동시에 받고 있었다.
 *   - 홈 밖 접근: `SYSTEM.md` "자유롭게 R/W" ↔ sysprompt "임의 경로는 매번 확인".
 *     실제로 후자는 통째로 무시됐다(지켜질 수 없는 단위였다).
 *   - 위임 조건·"실행" 동사도 각각 한쪽에만 예외가 있었다.
 *
 * ★뿌리는 크기가 아니라 **판단이 두 곳**이라는 것이다. 한쪽만 고치면 다른 쪽이 남고,
 *  실제로 `selfDevelopment` 를 도입할 때 `SYSTEM.md` 만 고쳐서 모순이 생겼다.
 *
 * 그래서 이 검사는 **조립된 전체**(sysprompt + SYSTEM.md)를 한 덩어리로 보고, 각 판단의
 * **정의 앵커**가 정확히 1회 나타나는지 센다. 0이면 옮기다 흘린 것(규칙 소실), 2 이상이면
 * 다시 두 벌이 된 것(갈림 재발). 프롬프트엔 타입체크가 없어 이 그물이 유일한 자동 방어다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * 판단별 **정의 앵커** — "그 규칙이 여기서 정의된다"고만 말하는 표현이라야 한다.
 * 다른 곳에서 *가리키는* 문장(예: "판정 기준은 SYSTEM.md 가 정본")은 앵커를 포함하지
 * 않으므로 카운트가 늘지 않는다 — 참조는 허용, 재진술은 금지가 이 검사의 뜻이다.
 */
const ANCHORS: Array<{ key: string; anchor: string; why: string }> = [
  {
    key: "위임 갈래",
    anchor: "독립·비중첩",
    why: "팀 구성 조건. 종전엔 sysprompt('각각 상당한 시간')와 SYSTEM.md('기존 스킬 있으면 예외')가 서로 다른 조건을 들었다",
  },
  {
    key: "앱 소스 수정",
    anchor: "selfDevelopment",
    why: "★모순의 진원 — 한쪽은 플래그 조건, 다른 쪽은 무조건 거절이었다",
  },
  {
    // 앵커는 **정의 전용 문구**여야 한다 — 첫 판에서 제목("홈 밖·위험 경로")을 앵커로 잡았다가
    // 그것을 *가리키는* 두 줄(§5·sysprompt)까지 세어 3회로 잡혔다. 참조는 허용이므로 앵커는
    // 정의 문장에만 나오는 구체 조건으로 내린다.
    key: "홈 밖·위험 경로",
    anchor: "새 폴더에 처음 손댈 때",
    why: "확인 단위(경로마다 → 작업 단위 1회). 두 벌일 때 한쪽이 통째로 무시됐다",
  },
  {
    key: "파괴·비가역 승인",
    anchor: "명시적 승인을 받는다",
    why: "안전 바닥. 이건 **sysprompt 에도 최소치가 남아 있어야** 하므로 아래에서 따로 본다",
  },
  {
    key: "사용자 동사",
    anchor: "쓴 동사까지 존중",
    why: "'실행'이 한쪽에선 금지 동사, 다른 쪽에선 완료 조건이었다",
  },
  {
    // 2026-08-06 — 사용자 층(AGENT.md)의 **역할 정의**는 헌법 §4 한 곳. 종전엔 정의가
    // sysprompt 에 8줄(2.1KB) 있고 §4 엔 한 줄뿐이었다 — **사용자가 통제하는 파일의 정의가
    // 사용자가 못 바꾸는 곳에** 있었다. 게다가 "룰·선호는 메모리로" 라고 시켜서, 매 턴
    // 지켜져야 할 규범이 **캡에 걸려 접히는 자리**로 가고 있었다(활성 163건 중 인덱스 43건).
    key: "사용자 층 정의",
    anchor: "사용자가 이 설치본에 주는 상시 지침",
    why: "규범의 자리가 없어 메모리로 갔고, 메모리 인덱스 캡에서 조용히 접혔다",
  },
  {
    // 2026-08-06 추가 — 헌법에 **처음** 명문화된 규칙이라 아직 형제가 없다. 그래서 지금
    // 넣는다: 이 부류(내용의 소속)는 AGENT.md·메모리·프로젝트 문서 셋으로 쉽게 번지고,
    // 번지면 "어디가 정본인가" 가 다시 갈린다(그게 애초에 이 규칙이 생긴 이유다).
    key: "프로젝트 내용 소속",
    anchor: "프로젝트 안이 정본",
    why: "AGENT.md 에 프로젝트 세부가 쌓여 정체성 파일이 오염됐던 것(2026-08-04 실측)",
  },
];

export const check: RegressionCheck = {
  name: "constitution-single-source",
  guards: "헌법이 두 벌이라 같은 상황에 다른 답을 주던 것(앱 소스·홈 밖·위임·동사 전부 갈려 있었다)",
  run: async (): Promise<Assertion[]> => {
    const { REGION_A_SYSTEM_PROMPT } = await import(
      "../../core/llm-runtime/adapters/_shared-sysprompt.js"
    );
    const sysprompt = String(REGION_A_SYSTEM_PROMPT);
    let constitution = "";
    try {
      constitution = readFileSync(path.join(REPO, "SYSTEM.md"), "utf8");
    } catch {
      /* 배포본엔 레포 SYSTEM.md 가 없을 수 있다 — 아래 전제 단언이 잡는다. */
    }
    const assembled = `${sysprompt}\n${constitution}`;
    const count = (hay: string, needle: string): number =>
      hay.split(needle).length - 1;

    const out: Assertion[] = [
      assert(
        "sysprompt·헌법 둘 다 읽는다(검사 전제 — 하나라도 비면 카운트가 무의미)",
        sysprompt.length > 2000 && constitution.length > 2000,
        `sysprompt ${sysprompt.length}자 · SYSTEM.md ${constitution.length}자`,
      ),
    ];
    if (constitution.length === 0) return out;

    for (const a of ANCHORS) {
      const n = count(assembled, a.anchor);
      out.push(
        assert(
          `★「${a.key}」 판단이 조립 전체에 정확히 1회 (${a.anchor})`,
          n === 1,
          n === 1
            ? "1회"
            : n === 0
              ? `★0회 — 옮기다 흘렸다(규칙 소실). ${a.why}`
              : `★${n}회 — 다시 두 벌이다(갈림 재발). ${a.why}`,
        ),
      );
    }

    // ★안전 바닥은 예외다 — 파괴·비가역 승인만은 sysprompt 에도 **최소치**가 남아야 한다.
    //  `readSystem()` 이 미러 실패 시 조용히 "" 를 반환하므로(identity.ts), 헌법이 비면
    //  나머지 규칙은 사라져도 이것만은 남게 하는 이중화다(부팅 경고 + /status 와 한 쌍).
    out.push(
      assert(
        "★헌법이 비어도 위험 도구 사전 승인은 sysprompt 에 남아 있다(안전 바닥)",
        sysprompt.includes("실행 전에 의도와 영향 범위를 사용자에게 확인"),
        sysprompt.includes("실행 전에 의도와 영향 범위를 사용자에게 확인")
          ? "sysprompt 최소치 있음"
          : "★안전 바닥이 사라졌다 — 헌법 부재 시 무방비",
      ),
    );

    // ★참조는 남아 있어야 한다 — 판단을 옮겼으면 "정본이 저기"라고 가리키는 줄이 있어야
    //  모델이 헌법을 무시하지 않는다(옮기고 링크를 안 남기면 그냥 사라진 것과 같다).
    out.push(
      assert(
        "sysprompt 가 헌법을 판단의 정본으로 가리킨다",
        sysprompt.includes("정본"),
        sysprompt.includes("정본") ? "참조 있음" : "★참조 없음 — 옮긴 규칙이 미아가 된다",
      ),
    );
    return out;
  },
};
