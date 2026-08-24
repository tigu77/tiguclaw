# eval-method — 스킬 증명 루프 상세

skill-creator Phase 3~6 의 형식·지표·조립 규격. 목적: "이 스킬/개선이 정말 나아졌나"를 통제된 대조로 정량 증명.

## 1. 테스트셋 (evals.json)

```json
[
  { "id": "e1",
    "prompt": "<이 스킬이 발동될 실제 사용자 요청 문장>",
    "assertions": [
      "<결과가 만족해야 할 검증 — 스킬이 있을 때만 통과할 것>",
      "<...>"
    ] }
]
```
- **id** 는 config·run 을 가로질러 안정적 키. 2~3개로 시작.
- assertion 은 **변별력** 있게: baseline(스킬 없음)도 당연히 통과하는 건 노이즈. grader 가 `weak_assertions` 로 잡지만 애초에 안 넣는 게 낫다.
- 실패 유도 케이스 1개 이상(스킬이 없거나 나쁘면 티나는 것).

## 2. 대조 실행 config

| config | 러너 프롬프트 skill-guidance | 언제 |
|---|---|---|
| `baseline` | 없음 (또는 **이전 스냅샷** 본문) | 신규=없음 / 개선=이전 버전 |
| `candidate` | **현재 SKILL.md 본문** 주입 | 항상 |

러너 프롬프트 골격:
```
<skill-guidance>
{candidate 일 때만: 현재 SKILL.md 본문 전체}
</skill-guidance>

{eval.prompt}
```
- 같은 프롬프트·같은 어댑터·오직 skill-guidance 유무만 차이 = 통제. `runs`(기본 3)회 반복해 분산 포착.
- 러너 = `spawn_agent({name:"skill-eval-runner", prompt})`. 반환 텍스트 + (가능하면) 소요시간/토큰 기록.

## 3. 채점 (grader)

각 (config, eval, run):
```
spawn_agent({ name: "skill-eval-grader", prompt:
  "eval_id: {id}\n\n원 프롬프트:\n{prompt}\n\n러너 결과:\n{runner output}\n\nassertions:\n- {a1}\n- {a2}" })
```
grader 반환 JSON 에서 `eval_id/passed_count/total_count/pass/weak_assertions/missing_checks/runner_failed` 를 취한다.

## 4. 결과 조립 (results.json → aggregate.mjs 입력)

grader 산출물들을 run 레코드 배열로 모은다:
```json
{
  "skill": "<name>",
  "runs": [
    { "config": "baseline", "eval_id": "e1", "run": 1,
      "pass": false, "passed_count": 1, "total_count": 3,
      "time_ms": 9000, "tokens": 3000, "runner_failed": false },
    { "config": "candidate", "eval_id": "e1", "run": 1,
      "pass": true, "passed_count": 3, "total_count": 3,
      "time_ms": 10000, "tokens": 3500 }
  ]
}
```
- `time_ms`/`tokens` 는 알면 넣고 모르면 생략(집계가 "—" 처리). `pass` 는 grader 의 전건통과 여부.
- config 이름은 자유 — 어댑터 비교 시 `claude`/`codex`/`openai`.

## 5. 집계 실행

```
node <skill-creator>/scripts/aggregate.mjs results.json --baseline baseline --candidate candidate
```
출력 지표(config 별, provider 중립):
- **pass_rate** (mean±sd) — 전건통과율. sd 는 표본(n-1); 높으면 flaky.
- **assert_rate** — passed/total 부분점수 평균(부분 개선 포착).
- **time_s / tokens** — 평균 비용.
- **Δ (candidate − baseline)** + 판정: pass_rate ↑ 개선 / ↓ 퇴보 / 동률=변별 안 됨(테스트셋 약함).

## 6. 신뢰성 체크 (판정 전)

- grader 의 `weak_assertions` 있으면 → 그 assertion 제거·교체 후 재측정(약한 검증 점수는 못 믿음).
- `missing_checks` 있으면 → assertion 추가.
- pass_rate_sd 크면 → runs 늘리거나 프롬프트 모호성 제거(flaky).
- 두 config pass_rate 동률 → 스킬이 실제로 값을 안 더하거나 테스트가 못 잡는 것. 둘 다 재검토.

## 7. 어댑터 비교 (LLM-agnostic, 옵션)

같은 candidate 스킬을 어댑터별로: config=`claude`/`codex`/`openai`. spawn_agent 는 호출별 model 오버라이드가 없고 model 은 **에이전트 정의**에서 오므로, 어댑터별 **러너 변형 에이전트**를 둔다 — `<home>/agents/skill-eval-runner-<provider>.md` 에 `skill-eval-runner` 와 동일 본문 + `model: "<provider>:<model>"` 핀. 각 config 는 그 변형으로 `spawn_agent` 한다. 집계는 `--baseline claude --candidate codex` 식으로 두 어댑터 delta. skill-creator[CC] 가 못 하는 티구클로 고유 기능.
