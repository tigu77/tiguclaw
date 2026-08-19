# http-bridge

양방향 HTTP/SSE bridge — 외부 plugin 이 데몬 EventBus(read) + channel input(write) 에 access.

## endpoint

- `GET  /health`     — 인증 무. `{ok, version, subscribers, ...}` 헬스체크.
- `GET  /events`     — 인증 필. SSE. `bus.history({limit:50})` 초기 푸시 후 라이브 fan-out.
- `GET  /inventory`  — 인증 필. `collectInventory()` JSON.
- `POST /messages`   — 인증 필. `{text, threadKey?, userId?}` → 비서 응답 `{replyText}` (60초 timeout).

## 환경변수

- `HTTP_BRIDGE_PORT` (default `7011`) — dashboard 의 `DASHBOARD_PORT`(기본 `7010`)와 분리.
- `HTTP_BRIDGE_TOKEN` — 부재 시 부팅 시 random 16-byte hex 발급, console 1줄 로그.

## 인증

`Authorization: Bearer <TOKEN>` 헤더 또는 `?token=<TOKEN>` query.

```
curl -H "Authorization: Bearer $TOKEN" http://localhost:7011/events
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"text":"안녕"}' http://localhost:7011/messages
```

## role

토큰은 `read` / `write` / `admin` 3종 role 1개를 보유한다. `admin` 은 모든 role 포함(superset).

| endpoint | 필요 role |
|---|---|
| `GET /health` | (인증 무) |
| `GET /events` | `read` ⊆ `write` ⊆ `admin` |
| `GET /inventory` | `read` ⊆ `write` ⊆ `admin` |
| `POST /messages` | `write` ⊆ `admin` |

부족한 role 의 토큰 → `403 {error:"forbidden", required, presented}`. 만료·revoked·미존재 토큰 → `401 {error:"unauthorized"}`.

### V1 호환

- `HTTP_BRIDGE_TOKEN` env 단일 토큰은 그대로 동작 (자동으로 `admin` role).
- env 부재 + DB 토큰 0개 = 부팅 시 ephemeral random hex 1개를 console 1줄 로그 + `admin` 메모리 보유 (V1 동작 그대로).
- env 토큰과 DB 토큰은 공존 — 둘 다 OR 매치.

### 토큰 발급

per-plugin 토큰 (role/expiry/label) 은 CLI 로 발급. 발급 시 1회 표시 후 DB 에는 sha256 hash 만 저장 — 분실 시 rotation 으로 회복 (revoke + 재발급).

```sh
npm run bridge:grant -- --label dashboard --role write --expires 30d
npm run bridge:tokens                       # 활성 토큰 목록 (hash·role·expires·label)
npm run bridge:tokens -- --revoke 3         # id=3 revoke
```

자세한 토큰 모델은 개발 저장소의 ADR `2026-05-16-dashboard-v2-tokens` §1.Q1/Q3 — 배포본에 없다.
