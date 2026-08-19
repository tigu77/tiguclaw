# 코드 지도 — 어디에 무엇이 있는가

> 짝 문서: [`core-boundaries.md`](core-boundaries.md) — 부팅·라우팅·권한의 **흐름**.

> **기준 커밋**: `9acfe6e` (2026-08-08) · **작성**: 개발돌쇠, 소스 독해 기반
>
> 설계의 **정본은 `README.md`** 이고(개발 저장소에선 `docs/architecture.md` ·
> `docs/decisions/` 도 — ★그 둘은 **배포본에 없다**), 이 문서는
> 그것을 대체하지 않는다. 여기 담는 것은 **좌표**뿐이다 — "무엇이 어느 파일에 있고, 어디를
> 건드리면 무엇이 조용히 깨지는가".
>
> **★스테일 판정법**: `git rev-list --count 9acfe6e..HEAD` 가 100을 넘으면 좌표가 밀렸다고
> 보고 §4 표부터 대조하라. 이 문서가 틀린 채 남는 것은 없는 것보다 나쁘다 —
> `.tiguclaw/analysis-cache/` 가 정확히 그렇게 썩었다(§9).

---

## 0. 이 문서의 신뢰도 두 층

한 문서 안에 확신도가 다른 것을 섞으면 전부 못 믿게 된다. 그래서 갈라 적는다.

| 층 | 무엇 | 상태 |
|---|---|---|
| **좌표층** | 어느 파일에 무엇이 있나 · 계약 · 목록 | 소스로 직접 확인 |
| **판단층** | 무엇이 위험한가 · 왜 이렇게 설계됐나 | ⏳ **적대적 재검증 진행 중** (§8) |

판단층 항목은 전부 ⏳ 로 표시돼 있다. **표시된 것을 근거로 코드를 고치지 마라.**

---

## 1. 한 장 흐름

```
채널(전부 플러그인) — cli · telegram · http-bridge · dashboard
      │  Channel.start(handler)
      ▼
직렬 큐 enqueueThreadTurn → 슬래시 fast-path → 매크로 → UserPromptSubmit 훅
      ▼
route()                          ← src/core/router.ts · 순수 운반자, 분기 0
      ▼
runClaude → llm-runtime facade   ← src/core/llm-runtime/index.ts
      ├── spec 해석 · 풀/체인 · 폴백 · 실패분류 · 쿨다운 · 관측   ← facade 전속
      └── callAdapter(switch) → claude(SDK) │ codex(자체 루프) │ openai
      ▼
Stop 훅 → outbound sanitize → 채널 reply
      ▼
SQLite 20테이블                  ← src/store/sessions.ts 단독 소유
```

**코어는 5종만 직접 만든다** — 런타임 · 라우터 · 권한 · 채널 인터페이스 · 메모리. 나머지는
플러그인이고, 이 경계는 선언이 아니라 실제로 지켜진다(cli·telegram 조차 플러그인이다).

---

## 2. 파일명이 내용과 다른 곳 ★신규 진입자 최대 함정

**이름으로 grep 하면 못 찾는다.** 실측으로 확인된 어긋남:

| 찾는 것 | 이름상 있을 곳 | **실제 위치** |
|---|---|---|
| region A 런타임 본체 | `src/core/claude.ts` | 거긴 **18줄 re-export shim**. 실체는 `src/core/llm-runtime/` 전체 |
| SSE **연결** | `packages/dashboard/js/sse.js` | `js/activity.js:410-449` (`connectStream`). `sse.js` 는 **디스패처만** |
| 프런트 부트스트랩 | `main.js` 류 | `js/tabs.js:447-450` — `DOMContentLoaded` 없이 top-level 즉시 실행 |
| 세션 탭 영속 | `js/tabs.js` | `js/activity.js:484-558` |
| 축1 선택지 | `js/axis1-options.js` | 헤더 주석만 그렇고 내용은 **진행표시 + 낙관적 큐 버블** |

★**주석도 믿지 마라.** `packages/dashboard/index.ts` 주석은 "read 토큰 / write 토큰 / admin
토큰"을 구분해 적지만 코드에는 **단일 `TOKEN` 상수 하나뿐**이다. 판정은 항상 코드로 한다.

---

## 3. 단일 정의점 — 여기 아니면 없다

여기서 갈라지면 그 순간 드리프트가 시작된다. **복사하지 말고 import 하라.**

| 무엇 | 유일한 정의처 |
|---|---|
| 모든 `CREATE TABLE` (20테이블) | `src/store/sessions.ts` — 나머지 14개 store 파일은 CRUD 헬퍼뿐 |
| 시스템/유저 프롬프트 조립 | `src/core/prompt-assembly.ts` |
| 실패 분류 · 폴백 · 쿨다운 · 턴 관측 | `src/core/llm-runtime/index.ts` (facade **전속**) |
| 3어댑터 공통 sysprompt 본문 | `src/core/llm-runtime/capabilities/_shared-sysprompt.ts` |
| SDK 서브에이전트 도구명 | `src/core/llm-runtime/subagent-tools.ts` → `SDK_SUBAGENT_TOOLS = ["Agent","Task"]` |
| 능력명 디렉터리 탈출 방어 | `capabilities/_names.ts` → `isSafeCapabilityName` |
| 자산 우선순위(project>user>plugin>builtin) | `capabilities/dedup-by-source.ts` |

---

## 4. 레이어별 좌표

### 코어
| 관심사 | 파일 |
|---|---|
| 부팅 시퀀스 · capability 별 start 분기 | `src/index.ts` (채널 start 는 플러그인 로드보다 **나중**) |
| 라우팅 | `src/core/router.ts` — abortSignal·toolPolicy·steering 을 **해석 없이 운반만** |
| threadKey 규약 · 세션 수렴 | `src/core/threadkey.ts` |
| 플러그인 로더 | `src/core/plugins/loader.ts` |
| 자가 갱신(원자 교체) | `src/core/self-update.ts` |

### LLM 런타임
어댑터 인터페이스는 `run()` **1면**뿐이고, 나머지 7면(세션 재개 · 도구 실행 · MCP 등록 ·
permission · 훅 · 자동발견 · 스트림)은 **의도적으로 어댑터 안에 캡슐화**돼 있다
(`types.ts:8-10`).

| 축 | claude | codex |
|---|---|---|
| agent loop 소유 | SDK 서브프로세스 | **어댑터가 직접**(raw fetch + SSE + function_call) |
| 파일/bash | SDK 네이티브 | `capabilities/file-ops-mcp.ts` 브리지 |
| 세션 | SDK resume + 시스템프롬프트 SHA-256 게이트 | resume 없음, 매 iteration 전체 재전송 |
| 히스토리 압축 | SDK 자체 | `openai-codex-oauth-history.ts` (문자수 임계) |

★`file-ops-mcp.ts` 가 **parity 의 척추**다 — 등록 도구명이 `Read`/`Glob`/`Grep`/`Write`/
`Edit`/`Bash`/`BashOutput`/`KillShell`/`WebFetch`/`WebSearch` 로 Claude Code 네이티브 이름을
**글자 그대로 미러**한다. sysprompt·훅 차단문구·activity detail 이 어댑터와 무관하게 같은
이름을 보게 하려는 것이다.

### 스토어
- 마이그레이션은 버전 번호 없음 — `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` probe +
  `ALTER TABLE ADD COLUMN`, ALTER 불가하면 DROP/RECREATE. 전부 `initStore()` 안.
- FTS5 는 `tokenize='trigram'` — **한국어는 형태소 분석이 없다.** 2글자 단어는 못 찾는다.
- 세션 정체성은 항상 `SESSION_STORAGE_CHANNEL="http-bridge"` 로 canonical 화된다.

### 플러그인
계약: `package.json` 의 `tiguclaw` 마커(`schemaVersion`·`kind`·`name`·`entry`) + **default
export class**. `kind` 는 `channel|observer|trigger|service` 중 하나 이상(겸할 수 있고, 겸해도
**인스턴스는 1개**). 마커가 없거나 형식이 틀리면 **조용히 skip** 된다.

`modules.disabled` 에 이름이 있으면 **인스턴스화 이전에** 걸러져 import 조차 안 한다.
**핫토글이 아니라 재시작이 필요하다**(MVP 한계, 코드에 명시).

### 대시보드
데몬과 **별도 프로세스**이고 외부 의존 0. http-bridge 엔드포인트로만 말한다. 토큰은
`proxyJson`/`proxyRaw`/`proxySse` **3개 헬퍼 안에서만** 붙어 브라우저에 안 나간다 —
미들웨어가 아니므로 새 프록시 헬퍼를 만들면 거기도 붙여야 한다.

★**프런트 `js/*.js` 33개는 독립 모듈이 아니다.** 원래 `index.html` 인라인 스크립트 하나를
잘라낸 조각들이라 파일 경계를 넘어 자유변수를 직접 참조한다(전부 6칸 들여쓰기로 시작하는
것이 그 흔적). **로드 순서가 곧 계약**이고, 함수를 다른 파일로 옮기면 TDZ 로 터진다.

★`index.html` 의 `<title>` 문자열이 **포트 점유 판정 마커**다(`plugins/dashboard/index.ts`).
제목을 바꾸면 중복 기동 방지가 오판한다.

---

## 5. 관통하는 불변식

이 레포를 이해한다는 건 이 6개를 아는 것이다.

1. **LLM-agnostic parity 가 최상위다.** 어떤 어댑터로 바꿔도 같은 동작이어야 한다. 훅 도구명
   정규화를 빠뜨려 차단 문구가 어댑터 간 **바이트 불일치**한 것도 위반으로 잡혔다.
2. **폴백으로 결함을 덮지 않는다.** 풀 *안*은 아무 실패나 다음 spec 으로 가지만, 풀 *간*
   (프로파일 간)은 **구조적 불가(모델 거부·provider 다운)만** 트리거다. 체인을 하나의 배열로
   평탄화하면 런타임 결함까지 폴백이 먹어 "claude 가 codex 버그를 가려주는" 상태가 된다.
3. **판정은 한 곳에.** `isModelRejected`·`classifyTurnError` 는 facade 단독. 어댑터에 `if` 를
   심는 순간 parity 가 깨진다.
4. **손으로 관리하는 목록은 드리프트한다.** 회귀 하네스가 자동 발견인 것도, 포트 리터럴
   감시 회귀가 있는 것도 같은 원칙이다.
5. **자리를 틀리면 조용히 망가진다.** §6.
6. **검증은 "되는 것"이 아니라 "안 되는 것"으로.** 토큰 격리는 내 토큰 200 이 아니라 **남의
   토큰 401** 로 확인한다. 새 회귀는 일부러 망가뜨려 빨간불을 본다.

---

## 6. 조용히 망가지는 자리 ★회귀가 전부 초록인데 깨지는 것

여기가 이 레포에서 제일 비싼 지식이다. 전부 **실사고 기록**이 남아 있다.

| 건드리면 | 무슨 일이 나나 | 지문 |
|---|---|---|
| 시스템 채널에 **턴마다 변하는 값**을 넣음 | 배치 회귀는 전부 초록인 채 **프리픽스 캐시만 죽는다** | `cached` 가 정확히 **3,456** |
| `SYSTEM_PROMPT_HASH` 에 스캐폴딩 포함 | AGENT.md 편집 한 번에 **세션이 끊기고** thread 전체 재prepend | — |
| 모델명을 손목록에 안 넣음 | `/status` 70/85% 경고가 **120턴 내내 한 번도 안 뜸** | `claude-*-5` 누락 사례 |
| 도구 이름 하드코딩 | SDK 0.3 의 `Task`→`Agent` 개명으로 **네 곳이 조용히 죽음**. 그중 하나는 하드컷 면제 명단이라 정상 서브에이전트를 죽일 뻔했다 | `isSdkSubagentTool` 단일 판정을 써라 |
| MCP callTool 타임아웃을 안쪽보다 짧게 | 정상 도구가 잘려 **11시간 outage** | 잡 소유 도구는 `JOB_OWNING_TOOL_CALL_TIMEOUT_MS` |
| 메모리 인덱스 8192바이트 초과 | 조용히 잘리고 검색으로만 도달 | 규범을 메모리에 두면 안 되는 이유 |
| 쿨다운을 메모리 Map 으로만 판정 | 재인증 후에도 안 풀리는 **자기 잠금** | 진실은 DB, Map 은 폴백 캐시 |
| 통지 좌표에 `channel` 사용 | `notifyDest` 를 무시해 알림이 **조용히 미배달** | — |
| 프런트 함수를 다른 파일로 이동 | TDZ → **채팅 통째 백지** | `js/util.js:21-33` 에 실측 수치 |
| SVG 첨부를 인라인 서빙 | 같은 오리진 스크립트 실행 → `?token=` **브리지 토큰 탈취**(실증됨) | 콘텐츠타입 매핑에서 의도적 제외 |
| 텔레그램에 MarkdownV2 재도입 | 표 셀 하이픈 등에서 parse 400 → **포맷 전체 손실** | 2026-07-23 에 HTML 로 되돌림 |

---

## 7. 명령 지도

| 목적 | 명령 | 비고 |
|---|---|---|
| 검증 | `npm run test:regression` | 568건 / 약 12.6초. 부담 없이 자주 |
| 타입체크 | `typecheck` · `typecheck:plugins` · `typecheck:bin` | **3종 분리** — src 만 도는 게 기본 |
| 배포 | `npm run deploy:dev` | ★**이것만.** `npm run deploy` 는 셸 env 가 새어 엉뚱한 인스턴스를 겨눈다 |
| 데몬 | `daemon:restart/stop/status/logs` | `bin/daemon.mjs` (의존성 프리) |

**`npm start` 는 죽은 스크립트다** — `dist/index.js` 를 가리키는데 실제 진입점은
`dist/src/index.js` 다.

**회귀 추가 = 파일만 만들면 끝.** `src/scripts/regression/<이름>.ts` 에
`export const check = { name, guards, run }` 를 쓰면 자동 발견된다. 등록 목록이 없다 —
"파일 추가하고 등록 잊음" 을 구조로 봉쇄한 것이다. 실행 시 `TIGUCLAW_HOME` 을 임시
디렉터리로 강제하고 `REGION_A_*`·`CODEX_*` 등을 봉인하므로 "내 머신에선 초록" 이 안 난다.

**원자 교체는 `/update` 에만 있다.** `deploy:dev` 는 `dist/` 에 직접 emit 이다.

> 인스턴스 지형(홈·포트·라벨) · 개발 순서(회귀→deploy:dev→라이브확인→`/update`)는
> **`PROJECT.md` 가 정본**이다. 여기 복사하지 않는다.

---

## 8. ⏳ 검증 대기 — 근거로 쓰지 마라

아래는 1차 분석에서 나온 **판단성 주장**이고, 중간 티어 에이전트 산출이라 신뢰도가 낮다.
현재 고티어 에이전트가 적대적으로 반증하는 중이며, 결과가 나오면 이 절을 확정 내용으로
교체한다.

- `busy_timeout` PRAGMA 부재가 실제 위험인가 (홈이 달라 **DB 도 각각**이면 경합이 성립 안 함)
- 대시보드 단일 토큰 + `bridge-tokens.ts` 의 env→admin 폴백 → 모든 `/api/*` 가 admin 인가
- CSRF 가드가 `Sec-Fetch-Site`·`Origin` 둘 다 없을 때 통과 → 결함인가 의도된 트레이드오프인가
- CSP 가 `<meta>` 라서 `frame-ancestors` 무효 → 실제 공격 시나리오가 성립하나
- 죽은 코드 3건(`#sd-body` · `.chat-tab` · `#hdr-back`) → 동적 생성이 아닌 진짜 사장(死藏)인가
- `deploy:dev` 비원자성 → 반쯤 갱신된 dist 로 데몬이 뜰 창이 실재하나
- capabilities 16개 × 3어댑터 **실제 등록 parity** → 미문서화 갭이 있나

---

## 9. `.tiguclaw/analysis-cache/` 는 읽지 마라 (2026-08-08 실측)

지도가 아니다. `code-map.md`(15바이트)·`flows.md`(12바이트)는 **빈 껍데기**이고, 나머지는
2026-07-22 텔레그램 작업 **하루치 로그**가 굳은 것이다.

- 뒤처짐: **338 커밋 / 17일** (`manifest.gitHead = 4bdc097`)
- **내용이 현실의 반대**: "telegramify MarkdownV2 로 교체" 라 적혀 있으나 실제 코드는
  HTML 서브셋이고, 2026-07-23 에 **MarkdownV2 를 금지**로 되돌렸다.

배경을 모르고 읽으면 그대로 회귀를 만든다. 처리 방향(삭제 / 재생성 / 경고 배너)은
사용자 결정 대기 중이다.
