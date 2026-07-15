# tiguclaw-dashboard

tiguclaw 데몬 외부 dashboard. http-bridge endpoint 통해서만 데몬과 통신.

## 파일 레이아웃 (2026-07-16 분해)

원래 `index.html` 한 파일(5,931줄, CSS+JS+마크업 전부)이었으나 단순+견고(특히 AI 협업 시
검증가능성)를 위해 관심사별로 분해했다. ADR: [`docs/decisions/2026-07-16-dashboard-decomposition.md`](../../docs/decisions/2026-07-16-dashboard-decomposition.md).

- `index.html` — 마크업 + `<link href=/app.css>` + `<script src=/js/*.js>` 나열(≈150줄).
- `app.css` — 전체 스타일.
- `js/*.js` — 뷰·기능별 모듈(classic 스크립트, **전역 렉시컬 스코프 공유** — 번들러 없음).
  `js/_manifest.json` = **로드 순서**(= 원본 라인 순서). `index.html` 의 `<script src>` 태그 순서가
  이와 일치해야 한다. ★즉시실행/부트스트랩이 섞여 있어 **순서가 중요** — 재정렬 금지. 새 모듈은
  `_manifest.json` 과 `index.html` 태그를 **같은 위치**에 함께 추가.
- `marked.min.js`/`highlight.min.js` — vendored(내용 고정·캐시). 앱 CSS/JS 는 `no-store`.

불변식 게이트: `scripts/verify-dashboard-split.mjs` (`packages/dashboard/**` 변경 시 실행) —
인라인 `<style>`/`<script>` 본문 0, 태그 순서 == `_manifest.json`, 디스크 `js/*.js` 집합 == 매니페스트.

## 사용

1. 데몬 부팅: `npm run dev` (다른 터미널). dev http-bridge 는 `.env HTTP_BRIDGE_PORT`(현재 `3000`) 에서 서빙.
2. http-bridge token 확인 — 데몬 부팅 로그의 ephemeral token 또는 `.env HTTP_BRIDGE_TOKEN` 설정. read 토큰이면 충분(`npm run bridge:grant -- --label dash --role read`).
3. `npm run dashboard` (이 터미널). `--env-file=.env` 라 `.env` 의 `DASHBOARD_PORT`·`HTTP_BRIDGE_PORT`·`HTTP_BRIDGE_TOKEN` 을 자동 공유.
4. 브라우저: `http://localhost:3002` (현재 `.env DASHBOARD_PORT=3002`).

## 포트 분리 (충돌 회피)

dashboard 는 두 개의 포트를 다룬다 — 혼동 금지:

| 역할 | env | 현재 dev 값 |
|---|---|---|
| dashboard 가 **연결**하는 http-bridge | `HTTP_BRIDGE_PORT` | `3000` (dev 데몬) |
| dashboard 가 **서빙**하는 UI | `DASHBOARD_PORT` | `3002` |

설치본 bridge `3001` / dev bridge `3000` / dashboard UI `3002` — 셋 분리.

## 환경변수

- `HTTP_BRIDGE_TOKEN` (필수, read role 이상)
- `HTTP_BRIDGE_HOST` (디폴트 `localhost`)
- `HTTP_BRIDGE_PORT` (연결 대상 bridge 포트, 코드 디폴트 `3001` / dev `.env`=`3000`)
- `DASHBOARD_PORT` (UI 서빙 포트, 코드 디폴트 `3000` / dev `.env`=`3002`)

## 외부 작성자 — 자기 dashboard 만들기

본 패키지는 *하나의 예시 dashboard* 입니다. http-bridge endpoint 사양을 따르면 누구나 자기 dashboard 를 만들어 같은 데몬에 붙일 수 있습니다 (Phase A 시연 — alt-dashboard 흐름).

### 1. endpoint 사양 (4종)

데몬의 `http-bridge` plugin 이 host `localhost`, 기본 port `3001` 에서 노출하는 endpoint. 자세한 명세는 [`plugins/http-bridge/README.md`](../../plugins/http-bridge/README.md) cross-link.

| endpoint | method | 인증 | 필요 role | 용도 |
|---|---|---|---|---|
| `/health` | GET | 무 | (무) | `{ok, version, subscribers, ...}` 헬스체크 |
| `/inventory` | GET | 필 | `read` | `collectInventory()` JSON — plugin/channel/skill 목록 |
| `/events` | GET | 필 | `read` | SSE 라이브 fan-out (`bus.history({limit:50})` 초기 푸시 후 라이브) |
| `/messages` | POST | 필 | `write` | `{text, threadKey?, userId?}` → 비서 응답 `{replyText}` (60초 timeout) |

인증 헤더 — `Authorization: Bearer <TOKEN>` 또는 `?token=<TOKEN>` query.

### 2. role 토큰 발급

read-only dashboard 면 `read` 토큰만 받으면 충분합니다. chat UI(채팅 송신) 포함이면 `write` 토큰.

```sh
# read-only alt-dashboard 작성자가 받는 토큰
npm run bridge:grant -- --label my-dash --role read

# chat UI 포함 alt-dashboard
npm run bridge:grant -- --label my-dash --role write --expires 30d
```

명령 출력의 raw token 은 **1회만 표시**되므로 발급 시점에 `.env` 또는 alt-dashboard 의 설정으로 저장. `admin` role 은 (V3) 토큰 관리 endpoint 용 — 외부 작성자에게는 발급하지 않는 게 일반적.

### 3. alt-dashboard 부팅 예시

```ts
// 외부 작성자의 alt-dashboard process — http 만 쓰면 됩니다
const TOKEN = process.env.MY_DASH_TOKEN; // bridge:grant 출력
const r = await fetch("http://localhost:3001/inventory", {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
console.log(await r.json());
```

read 토큰으로 `POST /messages` 호출 시 403, write 토큰으로 `GET /events` 호출 시 200 — role 게이트는 endpoint 별로 자동 적용 (`admin ⊇ write ⊇ read`).

### 4. cross-link

- http-bridge endpoint 명세 + role 매핑: [`plugins/http-bridge/README.md`](../../plugins/http-bridge/README.md)
- 토큰 발급/조회/철회 CLI: `npm run bridge:grant` / `npm run bridge:tokens` / `npm run bridge:tokens -- --revoke <id>`
