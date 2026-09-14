# eval-method — 스킬 증명 루프 상세

skill-creator Phase 3~6 의 형식·지표·조립 규격. 목적: "이 스킬/개선이 정말 나아졌나"를 통제된 대조로 정량 증명.

## 1. 테스트셋 (evals.json)

```json
[
  { "id": "e1",
    "prompt": "<이 스킬이 발동될 실제 사용자 요청 문장>",
    "assertions": [
      "<결과가 만족해야 할 요구 — 기본 기능 보존과 개선 효과를 모두 포함>",
      "<...>"
    ] }
]
```
- **id** 는 config·run 을 가로질러 안정적 키. 2~3개로 시작.
- assertion은 기본 기능 보존과 개선 효과를 함께 검사한다. baseline도 통과한다는 이유로 제거하지 않는다.
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
- 같은 프롬프트·모델·reasoning·도구·초기 상태·채점 기준을 고정한다. 실제 응답 모델도 기록한다. `runs`(기본 3)회 반복하고 순서를 교차한다. 각 실행은 독립 홈·작업 디렉터리와 새 대화에서 시작한다. 공유 파일을 수정하는 실행을 병렬로 띄우지 않는다.
- guidance를 강제로 읽힌 비교는 적용 후 행동 검사다. description의 자연 발동률은 별도 무주입 실험으로 측정한다.
- 러너 = `spawn_agent({name:"skill-eval-runner", prompt})`. 반환 텍스트 + (가능하면) 소요시간/토큰 기록.

> ★`spawn_agent` 은 **즉시 jobId** 를 돌려주고 기다리지 않는다. 독립인 것은 **전부 띄운 뒤**
>  `wait_for_worker([jobId, …])` 로 **한 번에** 합류하라 — 하나씩 합류하면 줄을 선다.


## 3. 채점 (grader)

각 (config, eval, run):
```
spawn_agent({ name: "skill-eval-grader", prompt:
  "eval_id: {id}\n\n원 프롬프트:\n{prompt}\n\n원본 산출물·실행 증거:\n{artifacts and trace}\n\nassertions:\n- {a1}\n- {a2}" })
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
- **time_s / tokens** — 관측된 실행의 평균과 관측/전체 수. 누락은 0이 아니다. 입력·캐시 입력·출력도 별도 보존한다.
- **Δ (candidate − baseline)**는 조건이 일치하는 동일 과제·반복 집합에서만 표시한다. 미관측 비용이 있으면 해당 비용 Δ는 보류한다. 동률은 보존 검사 통과일 수 있고, 차이는 이 표본의 관측이지 일반 성능 판정이 아니다.

## 6. 신뢰성 체크 (판정 전)

- `weak_assertions`는 요구와 무관하거나 증거로 판정 불가한지 검토한다. 기본 기능 보존 검사는 양쪽이 통과해도 제거하지 않는다.
- `missing_checks` 있으면 → assertion 추가.
- pass_rate_sd 크면 → runs 늘리거나 프롬프트 모호성 제거(flaky).
- 두 config pass_rate 동률이면 기본 기능 보존 여부와 비용·개별 실패를 함께 보고한다. 차이가 없다는 이유만으로 테스트가 약하다고 단정하지 않는다.

## 7. 어댑터 비교 (LLM-agnostic, 옵션)

같은 candidate 스킬을 어댑터별로: config=`claude`/`codex`/`openai`. spawn_agent 는 호출별 model 오버라이드가 없고 model 은 **에이전트 정의**에서 오므로, 어댑터별 **러너 변형 에이전트**를 둔다 — `<home>/agents/skill-eval-runner-<provider>.md` 에 `skill-eval-runner` 와 동일 본문 + `model: "<provider>:<model>"` 핀. 각 config 는 그 변형으로 `spawn_agent` 한다. 어댑터가 다른 경우 현재 집계기는 각 config 요약만 제공한다. 스킬 변경만의 효과와 모델·어댑터 차이를 분리할 수 없으므로 전후 Δ는 보류한다. skill-creator[CC] 가 못 하는 티구클로 고유 기능.

## 비교 입력 계약

각 run은 `config`, `eval_id`, 양의 정수 `run`, 불리언 `pass`, 정수 `passed_count/total_count`가 필수다.
`runner_failed`는 불리언이며 실패 실행은 pass=true가 될 수 없다. 실행 중복과 잘못된 수치는 오류다.
비교하려면 각 run의 `conditions`에 다음 문자열을 기록한다:
`adapter`, `model`, `served_model`, `reasoning`, `prompt_hash`, `fixture_hash`, `assertions_hash`.
동일 (eval_id, run) 쌍의 조건과 단언 수가 같아야 Δ가 나온다. 지침 버전의 해시는 별도 기록한다.
위 예시의 conditions 없는 과거 결과는 개별 요약만 가능하고 전후 비교는 보류된다.

`time_ms`, `tokens` 외 `input_tokens`, `cached_input_tokens`, `output_tokens`를 선택적으로 기록한다.
`tokens`의 정의는 실험 계획에 고정한다(예: 입력+출력, 캐시 입력은 입력의 부분집합).
미관측 값은 생략하고 일부 요청의 사용량이 빠졌으면 `accounting_incomplete:true`를 표시한다.
러너 실패도 결과 배열에 남긴다. 재시도는 비용을 버리지 않도록 모든 시도의 원본을 보존한다.
