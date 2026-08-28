// src/core/plugin-fetch.ts
/**
 * **플러그인이 밖으로 나가는 유일한 문** — 선언한 호스트만 (2026-08-28, 위젯 플랫폼 §D).
 *
 * ★설계엔 *"플러그인이 값으로 선언하고 코어가 집행한다"* 고 적어놨는데 **읽는 코드가 0**
 *  이었다. `weather` 의 `needs.network` 는 그냥 글자였다 — 선언이 집행 없이 있으면 그건
 *  약속이 아니라 **장식**이고, 다음 사람은 선언 없이 아무 데나 나간다.
 *
 * ★**여기가 유일한 출구인 이유는 우리가 정한 게 아니다.** 대시보드 CSP 가
 *  `connect-src 'self'` 라 브라우저는 외부로 못 나간다 — 플러그인의 외부 통신은 **정의상**
 *  데몬을 지난다. 그래서 한 곳에서 막으면 전부 막힌다.
 *
 * ★**정직한 한계**: 라이브러리가 자기 안에서 소켓을 여는 경우(grammy 등)는 여기를 안 지난다.
 *  이 문은 **플러그인이 직접 부르는 HTTP** 를 덮는다. 전부를 덮으려면 프로세스 격리가
 *  필요하고 그건 지금 0이다(설계 §H) — 덮는 범위를 넓혀 말하지 않는다.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { appRoot } from "./paths.js";

/** 플러그인 이름 → 선언한 호스트. 매니페스트는 재시작 전까지 안 바뀐다. */
const declared = new Map<string, ReadonlySet<string>>();

const hostsOf = (plugin: string): ReadonlySet<string> => {
  const cached = declared.get(plugin);
  if (cached !== undefined) return cached;
  let hosts: string[] = [];
  try {
    const p = path.join(appRoot(), "plugins", plugin, "package.json");
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as {
        tiguclaw?: { needs?: { network?: unknown } };
      };
      const n = pkg.tiguclaw?.needs?.network;
      if (Array.isArray(n)) hosts = n.filter((h): h is string => typeof h === "string");
    }
  } catch {
    /* 못 읽으면 선언 0 — 아무 데도 못 나간다(모르면 막는 쪽이 기본) */
  }
  const set = new Set(hosts);
  declared.set(plugin, set);
  return set;
};

/**
 * 선언과 대조 — 순수 판정. 회귀가 이걸 **실행해서** 확인한다.
 *
 * ★와일드카드를 안 만든다. `*.example.com` 을 허용하면 선언이 곧 "그 회사 전부" 가 되고,
 *  그건 사용자가 뭘 허락했는지 다시 모르게 되는 길이다. 필요해지면 그때 근거를 대고 넣는다.
 * ★http 도 막는다 — 평문으로 나갈 이유가 없고, 허용하면 그게 다운그레이드 통로가 된다.
 */
export const isDeclaredUrl = (hosts: ReadonlySet<string>, url: string): boolean => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return hosts.has(u.hostname);
};

/**
 * 플러그인용 `fetch`. **선언 안 한 호스트면 던진다.**
 *
 * @param plugin 플러그인 폴더 이름(= 이름공간). 매니페스트를 찾는 열쇠다.
 *
 * ★던지는 이유: 조용히 막으면 플러그인은 "네트워크가 안 되네" 로 오해하고 재시도 루프를
 *  돈다. 사유를 문장으로 주면 **개발자가 고칠 곳을 안다**(선언에 호스트를 추가하면 된다).
 */
export const pluginFetch = async (
  plugin: string,
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  const hosts = hostsOf(plugin);
  if (!isDeclaredUrl(hosts, url)) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url.slice(0, 60);
      }
    })();
    throw new Error(
      `플러그인 '${plugin}' 이 선언하지 않은 곳으로 나가려 했습니다: ${host}. ` +
        `package.json 의 tiguclaw.needs.network 에 호스트를 추가하세요(https 만 허용). ` +
        `현재 선언: [${[...hosts].join(", ") || "없음"}]`,
    );
  }
  return fetch(url, init);
};
