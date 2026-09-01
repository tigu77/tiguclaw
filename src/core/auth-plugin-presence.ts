/**
 * **이 설치에 어떤 구독 인증이 있나** — 디스크에 있는 플러그인이 선언한 것으로 판정한다.
 *
 * ★왜 필요한가 (2026-09-01 사용자 지시, v0.45.0 후속). 구독 인증을 코어에서 **번들
 *  플러그인으로 뺐다**(`claude-subscription-auth`·`codex-subscription-auth`). 그런데
 *  `onboard`(init)·`doctor` 는 여전히 **env 만 보고 무조건 물었다** — 그 플러그인을 뺀
 *  설치(Business 판 등)에서 *"Claude 구독 OAuth 를 고르세요"* 라고 안내하고, 고르면
 *  부팅 때 그 인증이 없어 조용히 폴백한다. **없는 능력을 권하는 상태**다.
 *
 * ★판정은 **이름 열거가 아니라 선언**이다([[feedback_hand_maintained_lists]]) —
 *  플러그인 매니페스트의 `tiguclaw.needs.auth` 를 읽는다. 새 인증 플러그인이 생겨도
 *  저절로 덮이고, 코어가 플러그인 이름을 알 필요가 없다.
 *
 * ★로더를 안 쓰는 이유: `init`·`doctor` 는 데몬이 아니라 **CLI** 다(부팅 전에도 돈다).
 *  플러그인 로더는 이벤트버스·호스트를 요구하므로 여기선 과하다. 매니페스트만 읽는다 —
 *  «이 설치에 그 파일이 있나» 가 정확히 우리가 묻는 것이다.
 * ★**활성/비활성은 안 본다.** 사용자가 껐다면 그건 되돌릴 수 있는 선택이고, 온보딩이
 *  물을지 말지는 «이 설치가 그 능력을 **가질 수 있나**» 로 정한다.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { appRoot, getPaths } from "./paths.js";

/** 한 폴더의 플러그인들이 선언한 auth id 를 모은다. 없는 폴더·깨진 매니페스트는 조용히 건넌다. */
const declaredIn = (dir: string): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // 폴더 부재 = 선언 0(로더의 부재-dir 관용과 동형).
  }
  const out: string[] = [];
  for (const name of entries) {
    try {
      const raw = readFileSync(path.join(dir, name, "package.json"), "utf8");
      const auth = (
        JSON.parse(raw) as { tiguclaw?: { needs?: { auth?: unknown } } }
      ).tiguclaw?.needs?.auth;
      if (Array.isArray(auth)) {
        for (const a of auth) if (typeof a === "string" && a !== "") out.push(a);
      }
    } catch {
      /* 매니페스트가 없거나 깨졌다 = 이 플러그인은 인증을 선언하지 않은 것으로 본다. */
    }
  }
  return out;
};

/** 이 설치가 제공할 수 있는 구독 인증 id 전부(번들 + 홈). */
export const declaredAuthProviders = (): Set<string> => {
  const ids = [...declaredIn(path.join(appRoot(), "plugins"))];
  try {
    ids.push(...declaredIn(path.join(getPaths().home, "plugins")));
  } catch {
    /* 홈 해석 실패 — 번들만으로 답한다(부팅 전 CLI 에서도 안전). */
  }
  return new Set(ids);
};

/**
 * 그 구독 인증을 이 설치가 제공할 수 있나.
 *
 * 쓰는 곳: `init`(고를 선택지에 넣을지) · `doctor`(진단할지).
 * id 는 플러그인이 선언한 값 그대로다 — 지금은 `claude-subscription`·`codex`.
 */
export const subscriptionAuthAvailable = (id: string): boolean =>
  declaredAuthProviders().has(id);
