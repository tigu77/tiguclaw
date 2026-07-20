# review-orchestration — 팬아웃/검증 프롬프트 템플릿 + findings 스키마

SKILL.md §B(high/ultra 워크플로우)에서 참조. 메인 턴이 `spawn_agent` 로 서브를 띄울 때 쓰는 프롬프트 본. 전부 `code-review` 에이전트(high 프로파일) 재사용 — 프롬프트 모드만 다르다.

---

## 1. 차원 리뷰 서브 프롬프트 (§B2)

차원별로 `{DIMENSION}`, `{GIT_RANGE}` 만 바꿔 병렬 호출:

```
spawn_agent({
  name: "code-review",
  prompt: `
[모드: 차원 리뷰 — {DIMENSION}]
대상: `{GIT_RANGE}` (예: git diff main...HEAD). Bash 로 직접 diff/파일을 읽어라.
담당 차원: {DIMENSION}  (correctness | simplification | efficiency | test-coverage)

먼저 invoke_skill 로 code-review 스킬 §A 방법론을 로드해 지켜라:
- 증상 아닌 근본 원인, 같은 원인이 인접 필드/경로에도 있는지 확장 점검(A2),
  코드베이스 관용구에 맞는 최소 수정.
- 담당 차원에만 집중. 다른 차원은 다른 서브가 본다.

발견을 아래 JSON 배열로만 반환(없으면 []):
[{ "file": "...", "line": 42, "category": "{DIMENSION}",
   "summary": "근본 원인 한 줄", "failure_scenario": "구체 입력/상태 → 오작동",
   "fix": "관용구 정합 최소 수정(어느 줄 어떻게)", "severity": "high|med|low" }]
추측 금지 — 코드로 확정한 것만.`
})
```

- 4차원 = 4회 호출(병렬). ultra 는 대상이 크면 `{GIT_RANGE}` 를 파일 그룹으로 좁혀 차원당 여러 서브(예: correctness-frontend / correctness-backend)로 늘린다.

## 2. 회의론자(적대) 서브 프롬프트 (§B3)

살아남길 시험할 **각 발견마다** N명(high=2, ultra=3~5) 독립 호출. 서로의 판단을 안 본다.

```
spawn_agent({
  name: "code-review",
  prompt: `
[모드: 적대적 반증 — 이 발견을 틀렸다고 입증하라]
목적: 그럴듯하지만 거짓인 발견을 걸러낸다. 너는 회의론자다.
대상 diff: `{GIT_RANGE}`
검증할 발견:
  file:line = {FILE}:{LINE}
  summary   = {SUMMARY}
  failure_scenario = {SCENARIO}

코드를 Bash/Read/Grep 으로 직접 읽어 이 발견의 반례를 찾아라:
- 그 failure_scenario 가 실제로 도달 가능한가? 상위에서 이미 막히지 않나?
- summary 의 근본 원인 주장이 코드와 맞나? 오독 아닌가?
- 이미 처리/방어되어 있지 않나?

판정만 JSON 으로 반환:
{ "refuted": true|false, "reason": "1~2줄 근거(반례 또는 견고성 확인)" }
반증 성공 또는 불확실 → refuted:true. 발견이 견고하다고 확신 → refuted:false.`
})
```

## 3. 집계 규칙 (메인 턴이 직접)

- 발견별로 회의론자 표 수집. 사망/에러 서브는 표에서 제외(§E degradation).
- **과반 refuted:true → 발견 폐기.** (예: 2명 중 2 또는 3명 중 2 → 폐기)
- 생존 발견 verdict: refute 0 → `CONFIRMED`, refute 소수 → `PLAUSIBLE`.
- 표 전멸(모든 회의론자 실패) → `PLAUSIBLE` + "검증 불가" 주석.

## 4. findings 최종 스키마 (§C 상세)

```json
{
  "rank": 1,
  "file": "src/foo.ts",
  "line": 42,
  "category": "correctness",
  "summary": "근본 원인 한 줄",
  "failure_scenario": "구체 입력/상태 → 오작동",
  "verdict": "CONFIRMED",
  "fix": "관용구 정합 최소 수정",
  "hardening": "재발 방지 1~2줄 (옵션)",
  "refuted_votes": "0/2"
}
```

- rank: 심각도 순(correctness·데이터손실·회귀 > 개선 > 테스트공백). 렌더는 §C 리스트/표.
- solo 리뷰는 이 스키마의 verdict/refuted_votes 를 생략(메인 직접 확신).

## 5. effort 폭 파라미터 요약

| effort | 차원 서브 | 회의론자/발견 | 라운드 | 모델 |
|---|---|---|---|---|
| solo | 0 (메인) | 0 | — | 메인 턴 |
| high | 4 (차원별 1) | 2 | 1 | code-review(high=opus) |
| ultra | 4~8 (차원×영역) | 3~5 | 1~2 | code-review(high=opus) |

opus 가 high 프로파일 최상위라 ultra 는 모델을 더 올리는 대신 **폭(서브 수·회의론자 수)·라운드**를 키운다. 커스텀 상위 프로파일이 settings.json 에 생기면 ultra 를 그 프로파일 에이전트로 승격 가능.
