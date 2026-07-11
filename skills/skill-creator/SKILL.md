---
name: skill-creator
description: "티구클로 스킬을 제대로 만들고 고치는 메타 스킬 (필요하면 정량 eval 로 개선을 증명). (1) '스킬 만들어줘/추가해줘', 새 스킬을 처음부터 작성할 때, (2) 기존 스킬을 개선·수정·최적화할 때, (3) 스킬이 정말 효과 있는지 eval(테스트 프롬프트 배치)로 벤치·측정하고 싶을 때, (4) 스킬 description 을 고쳐 트리거 정확도를 올릴 때, (5) self-growth 가 제안한 스킬 신규/개선을 실제로 만들 때 사용. harness 스킬(전문 에이전트 팀+오케스트레이션을 통째로 구성)과 구분 — 이건 *개별 스킬 하나*를 제대로 만드는 스킬이다. 대부분 초안+빠른 정성 확인이면 충분하고, 정량 증명은 중요·논쟁적일 때만 옵션. 스킬 실제 반영은 항상 사람 승인(human-gate)."
---

# Skill Creator — 스킬을 만들고·증명하는 메타 스킬

티구클로가 개별 스킬 하나를 **제대로** 만들 때 쓰는 절차. 핵심은 "만들었다"에서 끝내지 않고 **"정말 나아졌나"를 통제된 eval 로 정량 증명**한 뒤 사람 승인으로 반영하는 것.

## 언제 이 스킬 vs harness

- **harness** — 새 도메인에 맞는 *서브에이전트 팀 + 오케스트레이션 스킬*을 통째로 구성/확장.
- **skill-creator(이 스킬)** — *개별 스킬 하나*를 제대로 만든다. harness 가 개별 스킬을 만들 때 이 스킬을 참조해도 된다.

## 불변 원칙 (게이트)

- **가볍게가 기본**: 대부분의 스킬은 초안 + 빠른 정성 확인이면 충분하다. 아래 "정량 증명"은 **필수 단계가 아니라 필요할 때만 꺼내는 도구**다. 사소한 스킬에 테스트셋·N회 대조를 강제하지 마라(과설계 = 메타원칙 위반).
- **human-gate**: 스킬 파일 실제 생성/교체는 사람 승인 후. self-growth 단방향·human-gated 불변식 유지. 자동 반영 금지.
- **LLM-agnostic**: eval 을 돌릴 때도 어댑터 특수분기 0 — `spawn_agent`(어느 어댑터든)로만. `claude -p` 종속 러너 금지.
- **직접 만들지 않는다**: eval 엔진·채점 엔진 신설 금지. 기존 `spawn_agent`(러너/그레이더) + 집계 스크립트 1개만 조립.

---

# 기본 경로 (모든 스킬)

## 1. 무엇을 하는 스킬인지 정한다
스킬의 **의도**(사용자가 무엇을 원할 때 발동되어 무엇을 해주는가)를 한 문장으로 — 구현이 아니라 사용자 intent. `find_skills` 로 중복 확인. self-growth 제안(feedback 메모 `kind:"skill_proposal"`)에서 출발했다면 그 근거(반복된 도구 시퀀스)를 읽어 의도를 좁힌다.

## 2. 초안 작성
`references/skill-format.md` 규격대로 `SKILL.md` 를 `Write`:
- **위치**: 프로젝트 전용 `<project>/.tiguclaw/skills/<name>/`, 공통 `<home>/skills/<name>/`, 빌트인 레포 `skills/`. (매 턴 라이브 발견 → 재시작 불요.)
- **description**: 트리거 문구를 **적극적으로(pushy)** — "~할 때/~요청 시" 를 사용자 표현으로 여러 개. 구현 아니라 발동 조건. 길이 예산 의식(매 턴 인덱스에 prepend).
- **본문**: 명령형 절차. 상세는 `references/` 로 분리(본문 슬림).

## 3. 빠른 정성 확인 (이게 보통 충분하다)
- **트리거 점검**: should-trigger 문장 4~6개 / should-NOT(인접 스킬과 헷갈리는 near-miss) 4~6개를 적어 description 이 제대로 발동/미발동하는지 눈으로 검증. 과대/과소면 description 문구 조정.
- **동작 점검(선택)**: 대표 요청 1~2개를 `spawn_agent` 로 스킬 적용해 돌려보고 결과가 의도대로인지 확인.
- 여기서 만족스러우면 → **4. 반영**으로. (CC skill-creator 도 "human review loop is usually sufficient" — 정량 벤치는 부스터일 뿐.)

## 4. human-gate 반영
사람이 초안/확인 결과를 보고 승인하면 스킬 파일을 실제 위치에 둔다. self-growth 제안에서 출발했다면 그 제안 메모를 해소(closed) 안내.

---

# 정량 증명 루프 (필요할 때만)

**언제 켜나** — 다음일 때만. 아니면 위 "빠른 정성 확인"으로 끝내라:
- 스킬이 중요/논쟁적이라 "정말 값을 더하나"를 데이터로 봐야 할 때
- 개선을 반복 중인데 어느 버전이 나은지 애매할 때
- **self-growth 가 "이 개선이 나아졌다"고 주장** → 그 주장을 통제 실험으로 확인할 때
- 같은 스킬의 **어댑터별 성능**(claude/codex/gemini)을 비교하고 싶을 때 (CC 는 claude 전용이라 못 함)

**절차** (상세·형식·지표 = `references/eval-method.md`):
1. **테스트셋**: `{id, prompt, assertions}` 2~3개. 스킬이 있을 때만 통과할 assertion(변별력). 실패 유도 1개.
2. **대조 실행**: 각 eval 을 `runs`(기본 3)회 × 두 config 로 `spawn_agent({name:"skill-eval-runner"})`. baseline=스킬없음/이전스냅샷, candidate=프롬프트에 `<skill-guidance>현재 SKILL.md 본문</skill-guidance>` 주입. (동일 프롬프트·어댑터, guidance 유무만 차이 = 통제.)
3. **채점**: `spawn_agent({name:"skill-eval-grader"})` — 엄격 JSON(pass/passed_count/total_count + weak_assertions/missing_checks).
4. **집계**: 채점을 `{skill, runs:[...]}` 로 모아 `node <이 스킬>/scripts/aggregate.mjs <results.json> --baseline baseline --candidate candidate` → pass_rate(mean±sd)·time·tokens + **Δ + 판정**.
5. **개선 반복**: Δ≤0/고분산이면 실패 케이스로 본문·description 재작성 후 재측정(직전과 구조적으로 다르게). grader 의 weak/missing 경고로 테스트셋 보강.
6. **human-gate**: 표(Δ + 경고)를 채널로 보고, 승인 후에만 반영. 오래 걸리면 백그라운드 워커 + 완료 알림.

## 비채용 (하지 마라)

- 모델 훈련·trajectory 수집 (skill-creator[CC] 에도 없음 = 정합. 개선은 전부 SKILL.md·description 텍스트 재작성).
- 브라우저 뷰어·`claude -p`·`CLAUDECODE` 종속 (LLM-agnostic 위반).
- 처음부터 큰 자동 최적화 기계 — 필요해질 때 확장.
