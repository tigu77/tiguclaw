# file-watch

tiguclaw 트리거 두 번째 시민 — 파일/폴더 변경 감지 기반 가상 발화 plugin. scheduler (cron/reboot) 와 동급 reference — *외부 작성자가 자기 trigger plugin 만들 때 답습할 공개 시민*.

## 무엇이 가능한가

- 비서한테 자연어로 "**`./docs` 폴더가 변경되면 변경 요약해서 cli 로 출력해줘**" 라고 부탁하면 비서가 `add_watch` MCP 도구를 호출해 등록합니다.
- 데몬은 chokidar 가 fs 이벤트(add/change/unlink) 를 발견할 때마다 영역 A 를 발화 (`runClaude({ text: prompt(치환), threadKey: "file-watch:<id>", channel: "file-watch" })`) 시킵니다.
- prompt 안의 `{path}` `{event}` 토큰은 발화 시점에 실제 변경 경로·이벤트 종류로 치환됩니다.

## V1 범위

- fs 엔진: `chokidar@^5` (Win ReadDirChange / mac FSEvents / Linux inotify 모두 지원, deps total 1개).
- 옵션 5종 hardcoded: `path` / `pattern` / `recursive` / `debounce_ms` / `event_filter`.
- 발화 흐름은 `runClaude` 직접 호출 — destination push 가 필요하면 외부 작성자가 `dispatcher.ts` 를 watcher.ts 의 fireWatch 안에서 호출 추가 가능 (scheduler 처럼).
- overlap policy = chokidar `awaitWriteFinish` (debounce_ms 안의 폭주 fs 이벤트 1회로 묶음).
- 격리 try/catch — watcher 1개 throw 가 데몬 안 죽임. 다른 watch 진행 0 영향.

## 시연 — 3 케이스 (safety-check 스킬 카테고리 정합)

### safe (즉시 등록, 추가 승인 0)

```
add_watch({
  label: "docs-watch",
  path: "./docs",
  recursive: true,
  pattern: ".md",                     // glob 부분 매치
  event_filter: "add,change",         // 새 파일·수정만 (삭제 무시)
  debounce_ms: 1000,
  prompt: "{path} 가 {event} 됐어. 한 줄 요약 부탁.",
  dest_channel: "cli"
})
```

자체 폴더 감시 + 요약 prompt → 외부 영향 0.

### gray (사용자 1회 명시 확인 후 등록)

```
add_watch({
  label: "home-downloads",
  path: "C:/Users/me/Downloads",
  recursive: false,
  event_filter: "add",
  debounce_ms: 2000,
  prompt: "{path} 가 새로 다운로드됐어. 텔레그램으로 알려줘.",
  dest_channel: "telegram",
  dest_target: "12345"                // 사용자 본인 chat
})
```

사용자 home 일부 감시 + Telegram 송신 (외부 송신, 발화 시점 사용자 부재 우려).

### danger (강한 경고 + 사용자 명시 동의 후만 등록)

`safety-check` 스킬에서 다음 카테고리는 등록 *전* 명시 동의 필수:
- `/etc` · `~/.ssh` · `~/.aws` · `/proc` 같은 시스템·credential 디렉토리 감시 (정보 유출)
- `**` glob 으로 전체 디스크 감시 (폭주)
- 변경 시 자동 삭제/수정 prompt (예: "변경된 파일 즉시 삭제")

이 패턴이 의심되면 safety-check 스킬이 `add_watch` 호출 전 사용자 명시 승인을 요청합니다.

## MCP 도구 3종

비서가 자연어 요청을 받으면 내부적으로 호출합니다.

```
add_watch({
  label: "docs-watch",
  path: "./docs",                     // 절대/상대 (절대로 정규화)
  pattern: ".md",                     // optional — 매치 안 되는 경로는 ignore
  recursive: true,                    // optional, default true
  debounce_ms: 500,                   // optional, default 500
  event_filter: "all",                // optional — "all" | "add" | "change" | "unlink" | "add,change"
  prompt: "{path} 가 {event} 됐어. 요약 부탁.",
  dest_channel: "cli",
  dest_target: null                   // optional
})
→ { ok: true, id: 3, path: "/abs/path/to/docs" }

list_watches({ only_enabled: true })
→ { ok: true, items: [...] }          // 각 row 의 last_path/last_event/last_status 포함

delete_watch({ id: 3 })
→ { ok: true, deleted: true }
```

부재 path 는 `add_watch` 시점에 `{ ok:false, error:"path_not_found" }` 반환.

## 슬래시 명령 (V2 후속)

`/watch list` 등 슬래시는 V1 미포함. 자연어 + safety-check 스킬로 충분. V2 에서 scheduler `/schedule` 답습 4종 추가.

## 권한

- 발화는 `runClaude` 의 단일 권한 정책 (bypass + `disallowedTools`) — Phase 4 단일 정책 정합.
- 등록 시점의 prompt + path 위험성은 **시스템 프롬프트의 트리거 등록 게이트**가 평가한다 — 등록할 프롬프트가 나중에 사용자 없이 `bypassPermissions` 로 발화하므로, 위험이 있으면 등록 전 사용자 명시 승인 후만 `add_watch` 호출.

## 외부 작성자 답습 가이드 (5 섹션)

본 plugin 이 외부 작성자가 *자기 trigger plugin* 만들 때 답습할 공개 reference. scheduler 와 함께 2 시민으로 패턴 일반화 입증.

### 1. manifest 1줄 마커

`package.json.tiguclaw` 단일 객체:
```json
{
  "tiguclaw": {
    "schemaVersion": 1,
    "kind": ["trigger"],
    "name": "your-trigger-name",
    "entry": "./src/index.ts"
  }
}
```
- `kind`: `"trigger"` 또는 `["trigger"]` 또는 hybrid (`["trigger","observer"]`).
- `entry`: plugin dir 기준 상대 경로, default export = class.

### 2. lifecycle 2 method

```ts
export default class YourTriggerPlugin {
  async startTrigger(bus, deps?) {
    // 1) 부팅 시 활성 row 모두 watcher/cron/listener 등록
    // 2) bus.subscribe(...) — toggle event 처리
    // 3) MCP lifecycle hook 연결
  }
  async stop() {
    // 모든 watcher/cron close + bus.unsubscribe
  }
}
```
단일 capability fallback: `async start(bus)` 만 구현해도 OK (loader 가 duck typing).

### 3. EventBus pub/sub

```ts
// publish — 자체 event type 자유
bus.publish({
  type: "your-trigger.fired",
  ts: Date.now(),
  payload: { id, ... }
});

// subscribe — toggle 패턴 (scheduler.toggle / file-watch.toggle 동형)
const unsub = bus.subscribe((event) => {
  if (event.type === "your-trigger.toggle") {
    // payload: { id, action: "enable"|"disable"|"delete" }
  }
});
```
event type = string (literal union 강제 0) — 외부 plugin 자유 type 가능.

### 4. MCP server (optional)

`createSdkMcpServer({ name:"your-trigger", tools: [...] })` 노출. 옵셔널 instance method `getMcpServer()` 추가 시 데몬이 자동 발견 → 영역 A 에 등록. SDK 외부 이름: `mcp__your-trigger__{tool}`.

```ts
// ★부를 때마다 새 인스턴스를 돌려줘야 한다 — 데몬이 턴마다 부른다. 상수 하나를
// 돌려주면 동시 턴에서 MCP transport 가 충돌한다(Already connected to a transport).
getMcpServer(): McpSdkServerConfigWithInstance {
  return yourMcpServer;
}
```

### 5. dispatcher

발화 결과를 destination 채널로 push 할 때 자유 작성. file-watch `dispatcher.ts` 는 telegram/cli/http-bridge 3종 hardcoded — scheduler dispatcher 와 거의 동형. 외부 작성자는 자기 destination 추가 가능 (slack/discord/webhook 등).

## 한계 (V2 후속)

- 외부 process 격리 — V1 은 in-tree (데몬 죽으면 watcher 도 죽음).
- run history — `last_*` 컬럼 → 별 history 테이블 N건 보관.
- pattern glob — V1 은 부분 문자열 매치만, V2 picomatch 또는 chokidar 의 `ignored` 정식 glob.
- multi-path watch — V1 은 단일 path, V2 옵션 컬럼.
- `update_watch` MCP — V1 미포함 (scheduler v1 답습).
- `/watch` 슬래시 4종 — V2.
- `awaitWriteFinish` 옵션 노출 — V1 hardcoded 500ms threshold + 100ms pollInterval.
