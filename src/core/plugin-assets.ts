// src/core/plugin-assets.ts
/**
 * **플러그인이 브라우저에 파일을 실을 수 있게 한다** — 경로 판정만 (2026-08-28, 위젯 플랫폼 §E.1).
 *
 * ★설계: `docs/decisions/2026-08-28-widget-platform.md`. 위젯의 **브라우저 코드**는 플러그인이
 *  들고 오는데, 지금은 그걸 실을 길이 **0**이다(대시보드가 파일마다 손으로 쓴 라우트 3개를
 *  들고 있을 뿐이고 그건 대시보드 자기 자산이다).
 *
 * ★**왜 별도 모듈인가**(principle-check Q7): 이 판정의 **동작**을 검사하려면 서버를 띄워야
 *  한다면 그건 자리가 잘못된 것이다. 경로 트래버설은 정규식 grep 으로 지킬 수 있는 종류가
 *  아니다 — 회귀가 **실제로 호출해서** 뚫어봐야 한다. 그래서 순수 함수로 뽑는다.
 *  (이 레포엔 선례가 있다: `/logs` 유출 규칙을 `index.ts` 에 뒀더니 검사가 grep 밖에 못 됐고,
 *   30줄 모듈로 뽑자 변이 5/5 를 잡는 진짜 검사가 됐다.)
 *
 * ★**허용 집합을 손으로 안 만든다.** 플러그인 이름 화이트리스트도, 파일 목록도 없다.
 *  판정은 둘뿐이다: **①해석된 경로가 그 플러그인의 `web/` 안인가 ②확장자가 허용되는가.**
 *  플러그인이 늘어도 여기는 안 고친다([[feedback_hand_maintained_lists]]).
 *
 * ★**`web/` 밖은 못 준다.** 플러그인 폴더엔 `index.ts`(소스)·`package.json`·설정이 같이 있다.
 *  브라우저에 주는 것은 **의도적으로 그 아래 한 칸**으로 가둔다 — 플러그인 작성자가 실수로
 *  비밀을 폴더에 둬도 새지 않는다.
 */
import path from "node:path";

/** 브라우저에 줄 수 있는 것. **지금 필요한 것만** — 늘어나면 그때 넣는다. */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  // ★`.json` 은 **`web/` 안에서만** 도달한다 — 플러그인 설정(`<home>/plugins/<n>/settings.json`)
  //  과 매니페스트(`package.json`)는 `web/` **밖**이라 containment 가 이미 막는다.
  //  첫 판은 이걸 "설정이 샌다" 며 막았는데 근거가 틀렸다(자리를 안 보고 확장자만 봤다).
  //  플러그인이 **자기 번역 카탈로그**를 들고 오려면 이게 필요하다.
  ".json": "application/json; charset=utf-8",
};

export type PluginAssetResolution =
  | { ok: true; file: string; contentType: string }
  | { ok: false; reason: "shape" | "escape" | "type" };

/**
 * 여러 뿌리에서 **먼저 맞는 것**을 쓴다 — 번들이 앞, 홈이 뒤 (2026-08-28, 설치 형태).
 *
 * ★순서가 곧 정책이다: 같은 이름이면 **번들이 이긴다**(로더와 같은 규칙). 홈에서 코어
 *  플러그인의 자산을 가로채는 건 그 자체가 공격면이다.
 * ★가둠 판정은 **뿌리마다 따로** 돈다 — 뿌리를 합쳐 놓고 한 번 검사하면 한쪽의 `..` 가
 *  다른 쪽으로 새는 길이 생긴다.
 *
 * ★**실물이 있는지도 본다** — `exists` 를 주입받는다. 첫 판은 경로 *모양*만 보고 첫 뿌리를
 *  돌려줬고, 그래서 홈에만 있는 자산이 번들 경로를 가리켜 **404** 였다(실사용 확인에서 잡혔다).
 *  주입으로 받는 이유는 이 모듈을 순수하게 유지하기 위해서다 — 회귀가 가짜 `exists` 로
 *  우선순위를 **실행해서** 확인한다(fs 없이).
 */
export const resolvePluginAssetIn = (
  roots: readonly string[],
  urlPath: string,
  exists: (file: string) => boolean,
): PluginAssetResolution => {
  let last: PluginAssetResolution = { ok: false, reason: "shape" };
  for (const root of roots) {
    const r = resolvePluginAsset(root, urlPath);
    if (r.ok && exists(r.file)) return r;
    if (!r.ok) last = r;
  }
  // 모양은 맞는데 어느 뿌리에도 실물이 없다 — 라우트는 어차피 404 로 답한다.
  return last.ok === false ? last : { ok: false, reason: "shape" };
};

/** URL 경로의 접두사. 라우트와 검사가 같은 글자를 쓰게 한다. */
export const PLUGIN_ASSET_PREFIX = "/plugin-asset/";

/**
 * `/plugin-asset/<plugin>/<경로>` → 실제 파일 경로.
 *
 * @param pluginsRoot 플러그인 **코드** 루트 = `appRoot()/plugins` (홈이 아니다 — 홈의
 *   `plugins/` 는 설정·데이터 자리다).
 * @param urlPath 요청 경로(쿼리 제외). 퍼센트 인코딩된 채로 들어와도 된다.
 *
 * ★실패 이유를 셋으로 나누는 건 진단용이다 — 호출부는 전부 404 로 답한다(왜 막혔는지를
 *  밖에 알려주면 그 자체가 탐색 도구가 된다).
 */
export const resolvePluginAsset = (
  pluginsRoot: string,
  urlPath: string,
): PluginAssetResolution => {
  if (!urlPath.startsWith(PLUGIN_ASSET_PREFIX)) return { ok: false, reason: "shape" };

  // ★**먼저 디코드한다.** 안 하면 `%2e%2e%2f` 가 아래 containment 검사를 그대로 통과한다
  //  (경로를 문자열로 비교하는 검사가 늘 이렇게 뚫린다). 잘못된 인코딩은 거절.
  let rest: string;
  try {
    rest = decodeURIComponent(urlPath.slice(PLUGIN_ASSET_PREFIX.length));
  } catch {
    return { ok: false, reason: "shape" };
  }
  // NUL 은 경로 API 를 조기 종단시킬 수 있다. 역슬래시는 윈도우에서 구분자다.
  if (rest.includes("\0") || rest.includes("\\")) return { ok: false, reason: "shape" };

  const slash = rest.indexOf("/");
  if (slash <= 0) return { ok: false, reason: "shape" }; // 플러그인 이름 없음 · 파일 없음
  const plugin = rest.slice(0, slash);
  const relative = rest.slice(slash + 1);
  if (relative === "") return { ok: false, reason: "shape" };

  const ext = path.extname(relative).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (contentType === undefined) return { ok: false, reason: "type" };

  // ★**이름부터 가둔다.** 여길 빼먹으면 `plugin` 이 `..` 일 때 **base 자체가 위로 이동**해서
  //  아래 containment 가 그대로 통과한다 — 내가 첫 판에서 만든 구멍이고, 프로브가 잡았다
  //  (`/plugin-asset/../SYSTEM.js` → `/app/web/SYSTEM.js`). 이름 패턴을 새로 정하는 대신
  //  **"루트의 직계 자식인가"** 로 판정한다: 목록도 정규식도 안 생긴다.
  const root = path.resolve(pluginsRoot);
  const pluginDir = path.resolve(root, plugin);
  if (path.dirname(pluginDir) !== root) return { ok: false, reason: "escape" };

  // ★**해석한 뒤에 가둔다.** `..` 를 문자열로 찾아내는 대신 `path.resolve` 가 접은 결과가
  //  `web/` 안인지 본다 — 이쪽이 인코딩·중복 슬래시·심볼릭 표기에 안 속는다.
  const base = path.resolve(pluginDir, "web");
  const file = path.resolve(base, relative);
  // `base` 자신은 파일이 아니고, `base` 로 시작하기만 하는 형제(`web-secret/`)도 막는다.
  if (file !== base && !file.startsWith(base + path.sep)) return { ok: false, reason: "escape" };
  if (file === base) return { ok: false, reason: "shape" };

  return { ok: true, file, contentType };
};
