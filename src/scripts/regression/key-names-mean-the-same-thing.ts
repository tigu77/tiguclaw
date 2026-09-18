/**
 * 회귀: **같은 키 이름이 플랫폼마다 같은 뜻인가** (2026-09-18, 아스트라 적대 검토 N-P1).
 *
 * ★사고: 도구 설명은 `delete`·`home`·`end`·`pageup`·`pagedown` 을 **지원한다고 광고**했는데,
 *  - Windows `delete` = `0x2E`(**뒤** 글자 삭제) · mac `delete` = `51`(= backspace, **앞** 글자)
 *  - 탐색키 넷은 **mac 표에 아예 없었다** — 부르면 «알 수 없는 키 이름» 으로 던졌다
 *
 * ★★**이름은 계약이다.** 모델은 `key(["delete"])` 를 한 뜻으로 쓰는데 기계마다 다른 일이
 *  일어나면, 그건 조용한 오답이다(맥에서 앞 글자가 지워진다). 그리고 «지원한다» 고 적어놓고
 *  던지는 것은 문서가 거짓말하는 것이다.
 *
 * ★판정은 **손 목록이 아니라 대조**다 — 세 곳(도구 설명·mac 표·Windows 표)에서 이름을
 *  **뽑아서** 견준다. 새 키를 한 곳에만 추가하면 이 검사가 빨개진다
 *  ([[feedback_hand_maintained_lists]]).
 *
 * ★소스를 읽는 이유: 두 실행부의 표는 **다른 언어의 문자열**이라 tsc 가 안쪽을 못 본다.
 *  그래서 이 축은 «있는가» 를 텍스트로 묻는 수밖에 없다 — 대신 **양쪽을 다 읽어 견준다.**
 */
import { readFile } from "node:fs/promises";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = new URL("../../../", import.meta.url);

/** `name:코드` · `'name':코드` 를 모아 이름만 낸다(한 글자·숫자 키는 제외 — 그건 문자다). */
const macNames = (src: string): Set<string> => {
  const m = /var K = \{([\s\S]*?)\};/.exec(src.replace(/"\s*\+?\s*\n\s*"/g, ""));
  const out = new Set<string>();
  for (const hit of (m?.[1] ?? "").matchAll(/'?([A-Za-z][A-Za-z0-9]+)'?\s*:\s*\d+/g)) {
    out.add((hit[1] ?? "").toLowerCase());
  }
  return out;
};

/** `$VK=@{ name=0x..; 'name'=0x..; }` 에서 이름만 낸다. */
const winNames = (src: string): Set<string> => {
  // ★**`$VK=@{ … }` 안쪽만** 읽는다 (자기 변이로 적발). 고정 길이로 자르면 표 밖의
  //  상수(`$KEYUP`·`$UNI`·`$EXT`)까지 긁혀 «win 에만 있는 키» 로 보고된다 —
  //  스캐너가 눈이 큰 것도 눈이 먼 것과 같은 부류의 거짓이다.
  const start = src.indexOf("$VK=@{");
  if (start < 0) return new Set<string>();
  const close = src.indexOf("}", start);
  const chunk = src.slice(start, close < 0 ? start : close);
  const out = new Set<string>();
  for (const hit of chunk.matchAll(/'?([A-Za-z][A-Za-z0-9]+)'?\s*=\s*0x[0-9A-Fa-f]+/g)) {
    out.add((hit[1] ?? "").toLowerCase());
  }
  return out;
};

export const check: RegressionCheck = {
  name: "key-names-mean-the-same-thing",
  guards:
    "같은 키 이름이 플랫폼마다 다른 일을 하던 것(`delete` 가 맥에선 backspace 였다) · 도구 설명이 «지원한다» 고 광고한 탐색키가 맥 표에 아예 없어 던지던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const mac = await readFile(new URL("plugins/computer-use/src/mac.ts", REPO), "utf8");
    const win = await readFile(new URL("plugins/computer-use/src/win.ts", REPO), "utf8");
    const idx = await readFile(new URL("plugins/computer-use/src/index.ts", REPO), "utf8");

    const m = macNames(mac);
    const w = winNames(win);

    // ★**눈이 살아 있나** — 한쪽이 0개면 아래 대조가 공허하게 참이 된다.
    out.push(
      assert(
        "★스캐너의 눈이 살아 있다 — 양쪽 표에서 이름이 실제로 모인다",
        m.size >= 8 && w.size >= 8,
        `mac ${m.size}개 · win ${w.size}개`,
      ),
    );

    // ★**이름 집합이 같다** — 한쪽에만 있으면 그 기계에서 던진다.
    const onlyMac = [...m].filter((k) => !w.has(k));
    const onlyWin = [...w].filter((k) => !m.has(k));
    out.push(
      assert(
        "★★**양쪽 표의 키 이름이 같다** — 한쪽에만 있으면 그 기계에서 «알 수 없는 키» 로 던진다",
        onlyMac.length === 0 && onlyWin.length === 0,
        onlyMac.length + onlyWin.length === 0
          ? `공통 ${m.size}개`
          : `mac 만: ${onlyMac.join(",") || "-"} · win 만: ${onlyWin.join(",") || "-"}`,
      ),
    );

    // ★**`delete` 는 backspace 와 달라야 한다** — 같으면 이름 둘이 한 일을 한다.
    const macDel = /'delete':\s*(\d+)/.exec(mac)?.[1];
    const macBack = /backspace:\s*(\d+)/.exec(mac)?.[1];
    out.push(
      assert(
        "★`delete` 가 `backspace` 와 **다른 키**다(맥에서 둘 다 51 이라 앞 글자를 지웠다)",
        macDel !== undefined && macBack !== undefined && macDel !== macBack,
        `mac delete=${String(macDel)} · backspace=${String(macBack)}`,
      ),
    );

    // ★**도구 설명이 광고한 것이 양쪽에 다 있다** — 없으면 문서가 거짓말이다.
    const advertised = /이름: ([^"]+?)· 또는/.exec(idx.replace(/\s*"\s*\+\s*\n\s*"/g, ""))?.[1] ?? "";
    const names = [...advertised.matchAll(/([a-z][a-z0-9]+)/g)].map((x) => x[1] ?? "");
    const missing = names.filter((n) => n !== "" && (!m.has(n) || !w.has(n)));
    out.push(
      assert(
        "★도구 설명이 **광고한 이름이 양쪽에 다 있다** — 없으면 «지원한다» 가 거짓말이다",
        names.length >= 8 && missing.length === 0,
        names.length < 8
          ? `설명에서 이름을 ${names.length}개밖에 못 읽었다(파서가 눈을 잃었다)`
          : `광고 ${names.length}개 · 빠진 것: ${missing.join(",") || "없음"}`,
      ),
    );
    return out;
  },
};
