/**
 * **Codex 도구 접기** — 드물게 쓰는 도구를 소속 서버별 묶음(네임스페이스)으로 접고 OpenAI 기본 `tool_search` 로 펼친다 (2026-10-17).
 *
 * 계약: `docs/decisions/2026-10-17-tool-folding-contract.md`(아스트라 검토 반영). 근거·실측: 같은 날 조사 문서.
 * ★우리가 펼침 장치를 만들지 않는다 — 공급자 기본 기능이다(원칙 #5). 여기 있는 건 **무엇을 어떻게 묶나** 와 **`store:false` 라
 *  다음 턴에 다시 실을 검색 항목을 재구성하는 것** 뿐이다.
 * ★무엇을 접나는 정의가 이미 선언한다 — Claude 와 같은 `onDemand` 표식(`_meta["anthropic/searchHint"]`). 새 목록 없음.
 * ★낱개 접기(네임스페이스 없이 `defer_loading`)는 하지 않는다 — 탐침에서 입력 +41%(접힌 도구도 설명이 남고 검색 도구 고정비가 붙는다).
 * 리프 모듈 — 어댑터를 import 하지 않는다(회귀가 판정을 직접 돌린다).
 */

/** Responses `function` 도구(어댑터의 `convertMcpToolsToResponsesTools` 결과 모양). */
export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
  strict: false;
}

/** 접기 재료 한 줄 — 도구 정의 · 소속 서버 이름 · `onDemand` 힌트(null = 접지 않는 도구 · "" = 접되 설명엔 이름만 — 외부 MCP). */
export interface FoldEntry {
  tool: ResponsesFunctionTool;
  server: string;
  hint: string | null;
}

export interface FoldedNamespace {
  type: "namespace";
  name: string;
  description: string;
  tools: Array<ResponsesFunctionTool & { defer_loading: true }>;
}

export interface FoldResult {
  /** 요청에 싣는 도구 — 펼친 것(원래 순서) 뒤에 묶음(처음 나온 순서). `tool_search` 는 `searchTool` 일 때 호출부가 맨 뒤에 붙인다. */
  tools: Array<ResponsesFunctionTool | FoldedNamespace>;
  /** 이번 요청의 묶음 — 이름 → 정의. 다음 턴 재구성(`withRestoredToolSearch`)이 이것만 쓴다(현재 정의·현재 필터). */
  namespaces: Map<string, FoldedNamespace>;
  /** 접힌 도구가 하나라도 있으면 true — 없으면 `tool_search` 를 싣지 않는다(접힌 것 없이 실으면 400). */
  searchTool: boolean;
}

/** 네임스페이스 이름으로 쓸 수 있나 — 실측으로 받은 모양(영문·숫자·`_`·`-`)만. 아니면 그 서버는 접지 않는다. */
const NAMESPACE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 도구 목록을 접는다. `enabled` 가 아니면 **지금 그대로**(전부 펼침).
 * ★묶음 이름이 펼친 도구 이름과 겹치거나 이름 모양이 안 맞으면 그 서버는 접지 않는다(펼친 채 둔다 — 잃는 능력 없음).
 * ★묶음 설명은 **이 요청에 실제로 남은 접힌 도구의 힌트**로 만든다 — 역할 필터 뒤 없는 도구를 약속하지 않는다(계약 E).
 */
/** 공급자가 쓰는 이름 — 묶음 이름으로 쓰지 않는다(외부 MCP 서버 이름이 이렇게 지어질 수 있다, 적대 검토 10-19). */
const RESERVED_NAMESPACE = new Set(["web_search", "tool_search", "functions", "python", "browser", "multi_tool_use", "file_search", "computer_use"]);

export const foldCodexTools = (entries: readonly FoldEntry[], enabled: boolean): FoldResult => {
  if (!enabled) return { tools: entries.map((e) => e.tool), namespaces: new Map(), searchTool: false };
  const groups = new Map<string, FoldEntry[]>();
  for (const e of entries) if (e.hint !== null) groups.set(e.server, [...(groups.get(e.server) ?? []), e]);
  // ★펼쳐 둔 **모든** 도구 이름과 겹치는 묶음은 접지 않는다 — 표식 없는 도구만 세면, 이름 모양이 안 맞아 펼친 외부 서버의 도구가
  //  다른 서버 묶음 이름과 같아도 둘 다 실렸다(적대 검토 10-19). 한 서버를 펼치면 그 도구 이름이 또 겹칠 수 있으니 더 안 바뀔 때까지.
  const folded = new Set<string>();
  for (const server of groups.keys()) if (NAMESPACE_NAME.test(server) && !RESERVED_NAMESPACE.has(server.toLowerCase())) folded.add(server);
  for (let changed = true; changed; ) {
    changed = false;
    const flatNames = new Set(entries.filter((e) => e.hint === null || !folded.has(e.server)).map((e) => e.tool.name));
    for (const server of [...folded]) {
      if (flatNames.has(server)) {
        folded.delete(server);
        changed = true;
      }
    }
  }
  const namespaces = new Map<string, FoldedNamespace>();
  for (const [server, es] of groups) {
    if (!folded.has(server)) continue;
    namespaces.set(server, {
      type: "namespace",
      name: server,
      // 힌트가 빈 도구(외부 MCP)는 이름만 — 설명이 정의만큼 커지지 않게.
      description: `${server}: ${es.map((e) => (e.hint === "" ? e.tool.name : `${e.tool.name} — ${e.hint}`)).join(" · ")}`,
      tools: es.map((e) => ({ ...e.tool, defer_loading: true as const })),
    });
  }
  const tools: Array<ResponsesFunctionTool | FoldedNamespace> = [
    ...entries.filter((e) => e.hint === null || !folded.has(e.server)).map((e) => e.tool),
    ...namespaces.values(),
  ];
  return { tools, namespaces, searchTool: namespaces.size > 0 };
};

/** 검색 항목 두 개(서버 실행 모양) — 실측으로 받은 모양 그대로, `id` 없이(T1·T2). */
export const toolSearchItemsFor = (ns: FoldedNamespace): [Record<string, unknown>, Record<string, unknown>] => [
  { type: "tool_search_call", execution: "server", call_id: null, status: "completed", arguments: { paths: [ns.name] } },
  { type: "tool_search_output", execution: "server", call_id: null, status: "completed", tools: [ns] },
];

/**
 * **이력의 접힌 도구 호출을 이번 요청에 맞춘다** — 다음 턴에 다시 보낼 때.
 *
 * 저장은 호출의 `namespace` 하나뿐이다(정의는 저장하지 않는다 — 옛 정의·부풀림·권한 변화를 한꺼번에 피한다).
 *  · 이번 요청에도 그 묶음이 접혀 있으면 → 그 묶음을 쓰는 **첫 호출 앞**에 검색 항목을 현재 정의로 한 번 재구성한다(T2 — 다시 검색하지 않는다).
 *  · 그 묶음이 이번엔 없거나(플러그인 끔·역할 밖·접기 꺼짐·미지원 모델) → 호출에서 `namespace` 를 뗀다(펼친 도구는 이름만으로 맞다).
 * ★재구성은 정확성 장치가 아니라 **검색 한 번을 아끼는 장치**다 — 검색 항목 없이 `namespace` 호출만 있어도 받는다(T3, 다시 검색함).
 * ★같은 턴 안의 항목(응답이 준 실제 검색 항목)은 이미 있으니 건드리지 않는다 — 이력 구간(`[0, historyEnd)`)만 본다.
 */
export const withRestoredToolSearch = <T extends { type: string }>(
  items: readonly T[],
  historyEnd: number,
  namespaces: ReadonlyMap<string, FoldedNamespace> | null,
): Array<T | Record<string, unknown>> => {
  const out: Array<T | Record<string, unknown>> = [];
  const restored = new Set<string>();
  items.forEach((it, i) => {
    const ns = i < historyEnd && it.type === "function_call" ? (it as { namespace?: unknown }).namespace : undefined;
    if (typeof ns !== "string") {
      out.push(it);
      return;
    }
    const def = namespaces?.get(ns);
    // 묶음은 있어도 **그 도구가 이번엔 그 묶음에 없으면**(서버가 도구를 뺌·프로젝트가 같은 이름 서버로 덮음) 소속을 뗀다(적대 검토 10-19).
    const callName = (it as { name?: unknown }).name;
    if (def === undefined || !def.tools.some((t) => t.name === callName)) {
      const { namespace: _drop, ...rest } = it as T & { namespace?: string };
      out.push(rest as T);
      return;
    }
    if (!restored.has(ns)) {
      restored.add(ns);
      out.push(...toolSearchItemsFor(def));
    }
    out.push(it);
  });
  return out;
};

/**
 * **접기 흔적을 전부 뺀 사본** — 도구를 싣지 않는 요청(빈 응답 마무리 `tools: []`)·접기를 끈 재전송에 쓴다. 이 턴 구간까지 검색 항목을 빼고
 *  호출의 `namespace` 를 뗀다(`namespace` 없는 호출은 받는다 — T3). ★이 턴 구간을 남기면 도구 없는 요청에 검색 항목이 실렸다(적대 검토 10-19 —
 *  같은 모양의 웹 검색 항목은 서버가 거절했다).
 */
export const withoutToolSearch = <T extends { type: string }>(items: readonly T[]): T[] =>
  items
    .filter((it) => it.type !== "tool_search_call" && it.type !== "tool_search_output")
    .map((it) => {
      if (it.type !== "function_call" || (it as { namespace?: unknown }).namespace === undefined) return it;
      const { namespace: _drop, ...rest } = it as T & { namespace?: string };
      return rest as T;
    });

/**
 * 펼친 도구 호출을 실행해도 되나 — 호출의 `namespace` 가 있으면 **등록 정보의 소속 서버와 같아야** 한다(계약 B).
 *  이름 전역 유일 가정만으로 넘기지 않는다. `namespace` 가 없으면(펼친 도구) 이름 조회만으로 충분하다(지금 그대로).
 */
export const namespaceMatches = (callNamespace: string | undefined, toolServer: string | undefined): boolean =>
  callNamespace === undefined || callNamespace === toolServer;

/**
 * 턴 한 줄 관측(계약 F) — 접힌 묶음·도구 수 · 검색 횟수 · 펼친 묶음 · 접힌 도구 호출 수. 접기가 꺼진 턴은 null(줄 없음).
 *  «검색 없이 빈 답» 을 따로 판정하지 않는다 — 빈 답만으로 발견 실패를 판정할 수 없다(아스트라 회신 3).
 */
export const toolSearchStats = (turnItems: readonly { type: string }[], fold: FoldResult): string | null => {
  if (!fold.searchTool) return null;
  let searches = 0;
  let calls = 0;
  const loaded = new Set<string>();
  for (const it of turnItems) {
    if (it.type === "tool_search_call") searches += 1;
    else if (it.type === "tool_search_output") {
      for (const t of (it as { tools?: unknown[] }).tools ?? []) {
        const n = (t as { name?: unknown } | null)?.name;
        if (typeof n === "string") loaded.add(n);
      }
    } else if (it.type === "function_call" && typeof (it as { namespace?: unknown }).namespace === "string") calls += 1;
  }
  const folded = [...fold.namespaces.values()].reduce((n, ns) => n + ns.tools.length, 0);
  return `[codex-tool-search] 묶음 ${fold.namespaces.size}개(도구 ${folded}개) · 검색 ${searches}회 · ` +
    `펼친 묶음 ${loaded.size > 0 ? [...loaded].join(",") : "없음"} · 접힌 도구 호출 ${calls}회`;
};
