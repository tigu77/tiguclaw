# 플러그인 만들기

> 영어판: [plugins.en.md](plugins.en.md)

tiguclaw 는 플러그인으로 늘어납니다. 이 문서 하나만 보고 **위젯 하나 + 도구 하나**를 세울 수
있어야 합니다 — 안 되면 그건 문서 잘못이니 이슈로 알려주세요.

---

## 0. 먼저 알아야 할 것 — 격리가 없습니다

플러그인은 데몬과 **같은 프로세스**에서 돕니다. 파일을 읽고, 네트워크에 나가고, 코어를
`import` 할 수 있습니다. 아래에 나오는 권한 선언(`needs`)은 **강제가 아니라 선언**입니다 —
안 적어도 우회할 방법이 있습니다.

그래서 두 가지가 따라옵니다.

- **설치는 곧 신뢰 결정입니다.** 누가 만들었는지 모르는 플러그인은 깔지 마세요.
- **만드는 쪽에도 책임이 있습니다.** 무엇을 요구하고 무엇을 밖에 내보내는지는 작성자가
  정합니다. tiguclaw 는 *"사용자나 데몬이 다치는 것"* 만 막습니다.

---

## 1. 30초 판: 위젯 하나

플러그인은 폴더 하나입니다. `<홈>/plugins/hello/` 를 만드세요(홈은 보통 `~/.tiguclaw`).

**`package.json`**

```json
{
  "name": "hello",
  "version": "0.1.0",
  "description": "인사하는 위젯",
  "author": "당신 이름",
  "license": "MIT",
  "type": "module",
  "tiguclaw": {
    "schemaVersion": 1,
    "kind": "service",
    "name": "hello",
    "entry": "index.js",
    "needs": { "ui": ["chat-widget"] }
  }
}
```

**`index.js`** — 기본 내보내기는 **클래스**입니다.

```js
export default class Hello {
  // 데이터 라우트: 위젯이 모델을 안 거치고 값을 받는 길.
  getDataRoutes() {
    return {
      greeting: {
        ttlMs: 60_000,                      // 이 시간 안엔 다시 안 부른다
        handler: async (query) => ({ text: `안녕하세요, ${query.who ?? "세상"}!` }),
      },
    };
  }
}
```

**`web/widget.js`** — 브라우저에서 도는 부분입니다.

```js
window.tiguWidgets.register("hello/card", {
  mount(root, data, ctx) {
    const p = document.createElement("p");
    p.textContent = data?.text ?? "…";
    root.appendChild(p);
    // 타이머·구독이 있으면 여기 걸어두세요. 카드가 화면에서 사라질 때 불립니다.
    ctx.onDispose(() => { /* clearInterval 등 */ });
  },
});
```

> ★**`mount` 의 반환값은 쓰이지 않습니다.** 정리는 `ctx.onDispose(fn)` 로 겁니다(또는
> `unmount(root)` 를 같이 내보내도 됩니다). `return () => {}` 는 조용히 버려집니다.

데몬을 재시작하면 로그에 이렇게 뜹니다:

```
registered data routes from plugin: hello (greeting)
```

그리고 `/api/plugin-data/hello/greeting?who=정태` 로 값이 나옵니다.

> **위젯을 홈에 두려면** 비서에게 말하면 됩니다 — *"hello 카드를 홈 맨 위에 둬"*. 격자를
> 손으로 미는 화면은 없습니다(배치는 비서가 쓰는 데이터입니다).

---

## 2. 매니페스트 — `package.json` 의 `tiguclaw` 블록

| 키 | 뜻 |
|---|---|
| `schemaVersion` | 지금은 `1` |
| `name` | 플러그인 이름. 폴더명과 같게 두세요. **소문자·숫자·하이픈만** 쓰고 첫 글자는 소문자나 숫자여야 합니다(최대 64자) — `my-widget` 은 되고 `My-Widget` 은 **안 됩니다**. ★**앱과 함께 오는 이름은 예약**돼 있습니다 — 아래 참조 |
| `entry` | 폴더 기준 상대 경로. **기본 내보내기가 클래스**여야 합니다 |
| `kind` | 아래 표. 문자열 하나 또는 배열 |
| `needs` | 요구하는 것(§4) |
| `settings` | 사람에게 물어볼 것(§5) |

> ★**이름 규칙을 어기면 그 플러그인은 조용히 없는 것이 됩니다.** 화면엔 *"쓸 수 있는
> 플러그인을 못 찾았습니다"* 만 뜨고, 진짜 이유는 **로그에** 있습니다. 안 뜨면 이름부터
> 보세요.

`description`·`author`·`homepage`·`license` 는 **npm 표준 필드 그대로** 읽습니다 — 새 키를
만들지 않았습니다. 플러그인 목록에 그대로 보이고, 특히 **`author` 가 중요합니다**(격리가
없으니 "누가 만들었나" 가 설치 자리에서 유일한 판단 재료입니다).

### `kind` — 무엇으로 서는가

| kind | 구현할 것 | 언제 |
|---|---|---|
| `service` | (없음) | 도구·위젯·데이터만 낼 때. **대부분 여기** — 낼 것을 내면 그걸로 끝입니다 |
| `trigger` | `startTrigger()` | 스스로 깨어나야 할 때(주기·감시) |
| `observer` | `startObserver()` | 오가는 것을 지켜볼 때 |
| `channel` | `startChannel()` · `name` | 새 대화 채널을 붙일 때 |
| `provider` | 매니페스트에 `provider:{id,entry}` + 그 entry 가 모듈을 냄 | **대시보드 모듈 카드**를 낼 때 |

> ★**`provider` 는 «LLM provider» 가 아닙니다.** 이름이 그렇게 읽히지만, 이 kind 가 내는
> 것은 대시보드 «모듈» 화면 카드(요약·표·액션·이벤트)입니다. **새 모델 공급자를 붙이는
> 자리가 아닙니다** — 그건 지금 코어의 provider 레지스트리와 어댑터 구현이고, 플러그인
> 계약으로 열려 있지 않습니다.
>
> 쓰는 법: 매니페스트에 `"kind": ["provider"]` 와 `"provider": { "id": "plugin.<이름>",
> "entry": "./src/provider.ts" }` 를 적고, 그 entry 에서 셋 중 하나를 냅니다 —
> `collectProvider()` 가 모듈을 돌려주거나, `provider`/`default` 로 `{ id, load }` 를 냅니다.
> 실물은 번들 `self-growth` 가 `collectProvider()` 를 씁니다.

어느 kind든 아래는 **있으면 불립니다**(덕 타이핑):

- `start()` — 로드 직후 한 번
- `stop()` / `dispose()` — 끄거나 지울 때. **여기서 타이머·구독을 반드시 정리하세요**
- `getMcpServer()` — 모델이 쓸 도구(§3)
- `getDataRoutes()` — 위젯이 쓸 값(§6)

---

## 3. 도구 — 모델이 부르는 것

**아무것도 `import` 하지 않습니다.** 평범한 데이터로 적으면 됩니다.

```js
export default class Hello {
  getTools() {
    return [
      {
        name: "say_hello",                 // 소문자·숫자·밑줄
        description: "누군가에게 인사한다",   // ★모델이 이걸 보고 고릅니다. 꼭 적으세요
        parameters: {
          who: { type: "string", description: "인사할 사람" },
        },
        handler: async ({ who }, host) => `안녕하세요, ${who}!`,
      },
    ];
  }
}
```

- 인자 타입은 `string` · `number` · `boolean`. `enum: [...]` 으로 값을 좁힐 수 있고,
  `required: false` 면 모델이 생략할 수 있습니다.
- **문자열을 돌려주면 그게 답입니다.** 오류로 표시하고 싶으면 `{ text, isError: true }`.
- **던져도 대화는 안 끊깁니다** — 그 호출만 오류로 모델에게 돌아갑니다.
- 선언에 오타가 있으면 **그 도구만** 떨어지고 이유가 로그에 남습니다.

도구는 **모든 어댑터**(Claude·Codex·OpenAI)에서 같이 보입니다. 메인 대화든 스케줄 발화든
서브에이전트든 마찬가지입니다.

> ★**왜 SDK 를 안 쓰나.** 홈에 깔린 플러그인엔 `node_modules` 가 없어서
> `import ... from "@anthropic-ai/claude-agent-sdk"` 는 **로드에서 죽습니다.** 폴더에
> `npm i` 를 하면 되긴 하지만 실측 **247MB** 라, 도구 하나 선언하는 값으로는 맞지 않습니다.
> SDK 를 이미 쓰고 계시다면 `getMcpServer()` 도 그대로 됩니다(둘은 형제입니다).

---

## 4. `needs` — 요구하는 것

```json
"needs": {
  "network": ["api.example.com"],
  "ui": ["chat-widget"],
  "outbound": true,
  "llm": true,
  "auth": ["claude-subscription"]
}
```

| 키 | 뜻 |
|---|---|
| `network` | `host.fetch` 로 나갈 수 있는 호스트(https, 정확히 일치) |
| `ui` | 화면에 붙을 자리 — 지금은 `["chat-widget"]` |
| `outbound` | `host.say()` 로 **스스로** 말할 수 있음 |
| `llm` | `host.ask()` 로 모델을 부를 수 있음 — **그 모델은 도구를 안 씁니다** |
| `auth` | `host.registerAuthProvider()` 로 **구독 인증을 이 설치에서 허용**할 수 있음 — 적은 id 만 |

여기 없는 키를 적으면 로그에 경고가 남고 그 키만 무시됩니다(플러그인은 그대로 뜹니다).

선언은 **사용자에게 대가가 있는 것**에만 요구합니다 — 폰에 메시지가 가고, 돈이 나가고,
도구가 힘을 갖는 것. 이벤트를 구독하는 것처럼 대가가 없는 일엔 선언이 필요 없습니다.

그리고 §0 을 다시 떠올려 주세요: 이건 **보안 경계가 아닙니다.** 선언의 값은 사람이 설치할
때 무엇을 요구하는지 **보인다**는 데 있습니다.

---

## 5. `settings` — 사람에게 물어보는 것

```json
"settings": [
  { "key": "units", "type": "enum", "values": ["metric", "imperial"], "default": "metric" },
  { "key": "apiKey", "type": "secret" }
]
```

타입은 `string` · `number` · `boolean` · `enum` · `secret`.

설정 화면의 행은 **이 선언에서 저절로 만들어집니다.** 화면 코드를 쓸 필요가 없습니다.

★**`secret` 은 파일에 저장되지 않습니다.** 홈 `.env` 에서 읽고, 화면엔 **있다/없다만**
보입니다. 값이 없으면 키 자체가 없습니다(빈 문자열이 아닙니다).

이름 규칙은 `TIGUCLAW_PLUGIN_<이름>_<키>` 를 대문자로, `-` 는 `_` 로 바꾼 것입니다:

```
hello       / apiKey   →  TIGUCLAW_PLUGIN_HELLO_APIKEY
my-plugin   / api-key  →  TIGUCLAW_PLUGIN_MY_PLUGIN_API_KEY
```

---

## 6. 데이터 라우트 — 위젯이 값을 받는 길

```js
getDataRoutes() {
  return {
    forecast: {
      ttlMs: 10 * 60_000,
      handler: async (query, host) => {
        const r = await host.fetch(`https://api.example.com/f?q=${query.place}`);
        return await r.json();
      },
    },
  };
}
```

- `GET /api/plugin-data/<플러그인>/<라우트>?...` 로 열립니다.
- **TTL 안에는 캐시가 답합니다** — 탭이 몇이든 밖으로는 한 번. 동시에 물으면 합쳐집니다.
- **실패는 캐시하지 않습니다** — 새로고침하면 다시 시도합니다.
- **바이트도 낼 수 있습니다**: `{ contentType: "image/png", body: Uint8Array }`
  (지도 타일 등). 상한은 2MB 입니다.

---

## 7. `host` — 플러그인이 만질 수 있는 전부

`getDataRoutes` 의 핸들러와 도구 구현이 받습니다.

| | |
|---|---|
| `host.fetch(url, init)` | 밖으로. `needs.network` 에 적은 호스트만 |
| `host.settings` | 이 플러그인 몫 설정만(§5). 남의 것도, 코어 것도 안 보입니다 |
| `host.dataDir` | 이 플러그인 몫 저장 자리(`<홈>/plugins/<이름>`) |
| `host.locale` | 설정 언어 — 외부 API 에 언어를 넘길 때 |
| `host.log(msg)` | 로그. 접두사가 자동으로 붙습니다 |
| `host.postCard({text, widget, data})` | **지금 하는 답**에 카드를 붙입니다 |
| `host.on(type, fn)` | 코어 이벤트 구독. `"worker."` 처럼 `.` 으로 끝나면 접두사 |
| `host.say({channel, target, text})` | **스스로** 말합니다(`needs.outbound`) |
| `host.ask({prompt, scope})` | 모델에게 묻습니다(`needs.llm`) |
| `host.registerAuthProvider(p)` | 구독 인증을 켭니다(`needs.auth`). 부팅 때 `startService(bus, host)` 에서 부르세요 |

★**`say` 와 `ask` 는 실패를 값으로만 말합니다** — 로그에 안 남습니다. 반드시 받아서 보세요:

```js
const r = await host.say({ channel: "telegram", target: null, text: "끝났습니다" });
if (!r.ok) host.log(`못 보냄: ${r.error}`);      // needs.outbound 를 안 적었으면 여기로 옵니다

const a = await host.ask({ prompt: "한 줄로 요약해줘" });
if (a.ok) host.log(a.text);                       // ★`a` 를 그대로 쓰면 [object Object] 입니다
```

`postCard` 와 `say` 는 다릅니다. 앞은 *"지금 하는 답에 붙인다"* 라 **대화 중일 때만** 되고,
뒤는 *"내가 먼저 말한다"* 라 언제든 됩니다.

`ask` 는 좁습니다 — 모델·프로바이더를 고를 수 없습니다. 그건 사용자의 프로파일 설정이
정합니다(그래야 어떤 백엔드로 바꿔도 플러그인이 그대로 돕니다). 대화 좌표도 인자가 아니라
`plugin:<플러그인>:<scope>` 로 만들어집니다 — 남의 대화엔 닿지 않습니다.

**주기적으로 뭔가 하고 싶다면** `setInterval` 을 그냥 쓰세요. 막아둔 것 없습니다.
`stop()`/`dispose()` 에서 정리만 해주시면 됩니다.

---

## 8. 브라우저 쪽 — `window.tiguWidgets`

```js
window.tiguWidgets.register("<플러그인>/<위젯>", {
  mount(root, data, ctx) {
    // ... root 안에 그린다
    ctx.onDispose(() => { /* 타이머·구독 정리 */ });
  },
  // 선택 — 떼어질 때 직접 치우고 싶으면
  unmount(root) {},
});
```

★**정리는 `ctx.onDispose` 또는 `unmount` 로만 됩니다.** `mount` 가 돌려주는 함수는
쓰이지 않습니다.

`ctx` 가 주는 것:

- `ctx.t("key")` — 번역. 문장을 서버에서 받지 마세요. `web/locales/ko.json`·`en.json` 에
  두면 사용자 언어로 나갑니다.
- `ctx.resource(name, fetchSnapshot)` — 실시간 값. 순서·재연결·스냅샷은 신경 쓸 필요
  없습니다. `.subscribe(fn)` 하면 값만 옵니다.
- `ctx.onDispose(fn)` — 카드가 사라질 때 부를 정리 함수.
- `ctx.locale` — 보는 사람의 언어.

`web/` 아래 파일은 `/plugin-asset/<플러그인>/<경로>` 로 서빙됩니다. CSS 는 거기서 링크하세요.

**색을 직접 쓰지 마세요.** 테마 토큰(`var(--fg)` 등)을 쓰면 사용자 테마를 따라갑니다.

---

## 9. TypeScript 로 쓰기

**그냥 쓰시면 됩니다.** TypeScript 로 쓰고 컴파일해서 `entry` 를 그 결과물로 가리키세요 —
우리한테서 import 할 것은 없습니다.

★**타입 패키지는 제공하지 않습니다.** 계약은 **이 문서**입니다. 여기 적힌 것
(`getTools`·`getDataRoutes`·`host.*`·`window.tiguWidgets`)은 **안 깨뜨립니다.** 여기 없는
걸 쓰면 다음 버전에 깨져도 약속 밖입니다.

타입 패키지를 두면 버전·동기화·deprecation 이 따라오는데, 그건 여러분에게 주는 값보다
우리가 지는 부채가 큽니다. 필요해지면 그때 만듭니다.

에디터 도움은 JSDoc 으로 충분합니다:

```js
/** @param {{ text: string }} args @param {import("./types").PluginHost} host */
handler: async (args, host) => `안녕, ${args.text}`,
```

---

## 10. 배포

셋 다 됩니다 — 로더는 **매니페스트 + 불러올 수 있는 진입점**만 봅니다.

| 형태 | 하는 법 |
|---|---|
| 소스 폴더 | `<홈>/plugins/<이름>/` 에 그대로 두기 |
| 번들 `.js` | `entry` 를 번들 파일로. 소스를 안 내도 됩니다 |
| npm | `npm pack` → 홈에 풀고 **폴더 이름을 플러그인 이름으로 바꾸기**(아래 ★) |

★**폴더 이름이 곧 플러그인 이름이어야 합니다.** `npm pack` 이 만든 tarball 은 루트가
`package/` 라, 그대로 풀면 `<홈>/plugins/package/` 가 됩니다. 그러면 플러그인은 로드되고
도구·데이터 라우트는 도는데 **위젯 자산이 404 나고 `host.dataDir` 이 없는 폴더를 가리킵니다**
— 반쪽만 되는 조용한 실패입니다. 풀고 나서 폴더 이름을 바꾸세요.

번들·npm 은 **소스를 공개하지 않아도 된다**는 뜻이기도 합니다.

---

## 11. 안 되는 것 · 조심할 것

- **핸들러가 던져도 데몬은 안 죽습니다** — 그 요청만 502 가 되고 로그에 남습니다. 다만
  `start()` 에서 던지면 그 플러그인만 로드에 실패합니다(다른 플러그인은 무사합니다).
- ★**앱과 함께 오는 플러그인의 이름은 못 씁니다.** 지금 예약된 이름은 `claude-subscription-auth`·`cli`·
  `codex-subscription-auth`·`dashboard`·`file-watch`·`http-bridge`·`running-work`·`scheduler`·
  `self-growth`·`telegram` 입니다. 폴더명이 아니라 **매니페스트의 `name`** 으로 봅니다(폴더는 아무렇게나
  둬도 됩니다). 그 이름으로 설치하면 *"같은 이름의 번들 플러그인이 있습니다"* 로 거부됩니다 —
  그 플러그인이 꺼져 있거나 로드에 실패했어도 마찬가지입니다. 이름은 예약된 것이지 그날
  잘 떴느냐에 달린 게 아닙니다.
- **위젯 설정에 열쇠를 넣지 마세요.** 그 값은 브라우저로 나가고 백업에 들어갑니다 —
  열쇠는 `secret` 타입이나 `.env` 로 두세요. 거부는 **이름으로** 걸립니다: `apiKey`·
  `authToken`·`passphrase`·`signingKey` 처럼 열쇠 낱말이 들어가면 값과 무관하게 막힙니다.
  ★`chartKey`·`sortKey` 처럼 평범한 이름도 같이 막힙니다 — `apiKey` 와 문법이 같아서
  (수식어 + `key`) 이름만으로는 못 가르고, 새는 쪽이 되돌릴 수 없어서 막는 쪽을 골랐습니다.
  막히면 사유가 함께 뜨니 이름을 바꾸거나 `secret` 으로 선언하세요.
- **끌 때 정리하세요.** 타이머·구독을 안 끄면 꺼진 플러그인이 계속 깨어납니다.
- **`plugins/<이름>/src/` 에 컴파일 산출물을 커밋하지 마세요** — `index.ts` 가 `./x.js` 를
  부르는데 그 파일이 실재하면 옛 코드가 돕니다.

---

## 12. 막히면

플러그인이 안 뜨면 로그부터 보세요 — `[plugin-loader]` 줄이 이유를 말합니다.

```
tiguclaw logs | grep plugin
```

그래도 모르겠으면 [이슈](https://github.com/tigu77/tiguclaw/issues)로 알려주세요.
**"문서만 보고 안 됐다" 는 그 자체로 유효한 버그입니다.**
