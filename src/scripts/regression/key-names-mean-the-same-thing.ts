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
import { assert, type Assertion, type RegressionCheck, loadPluginModule } from "./_framework.js";

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
    // ★★**«있다» 가 «같은 뜻이다» 를 보장하지 않는다** (2026-09-19, 돌쇠 실기).
    //  `home` 은 양쪽 표에 다 있고 위 대조를 **통과한다** — 그런데 Windows 는 캐럿을 옮기고
    //  **맥은 화면만 스크롤한다.** `delete`(51 vs 117)와 같은 부류인데 이쪽은 **조용하다**:
    //  키는 성공으로 돌아오고 캐럿만 안 움직여서 재관측 없이는 못 본다.
    //  → 그래서 이름 대조와 **별개로**, 뜻이 갈리는 이름은 **광고하지 않는다**를 잰다.
    const AMBIGUOUS = ["home", "end", "pageup", "pagedown"];
    const advertisedAmbiguous = AMBIGUOUS.filter((n) => names.includes(n));
    out.push(
      assert(
        "★★뜻이 플랫폼마다 갈리는 이름은 **광고하지 않는다**(맥 home 은 스크롤만 한다)",
        advertisedAmbiguous.length === 0,
        advertisedAmbiguous.length === 0
          ? `광고 목록에 없음: ${AMBIGUOUS.join(",")}`
          : `★광고돼 있다: ${advertisedAmbiguous.join(",")}`,
      ),
    );
    out.push(
      assert(
        "★그리고 **왜 쓰지 말라는지**를 같이 말한다 — 이름만 빼면 모델은 그냥 모른 채 쓴다",
        AMBIGUOUS.every((n) => idx.includes(n)) && idx.includes("스크롤"),
        `설명에 있는 이름: ${AMBIGUOUS.filter((n) => idx.includes(n)).join(",") || "없음"}` +
          ` · «스크롤» 이라는 사유: ${String(idx.includes("스크롤"))}`,
      ),
    );

    // ── ★수식키 표도 대조한다 (2026-09-19, 아스트라 재검토 §3) ────────────────────
    //  ★종전엔 **일반 키 표(K·$VK)만** 봤다. 수식키는 `MODK`·`$MODVK` 에 따로 사는데
    //   아무도 안 봤고, 실제로 **`win` 이 한쪽에만** 있다(맥엔 없어서 던진다).
    //  ★차이 자체는 결함이 아니다 — **그 차이가 계약(`PLATFORM_KEY_GAPS`)과 같은가**가 계약이다.
    const modNames = (src: string, re: RegExp): Set<string> =>
      new Set([...(re.exec(src)?.[1] ?? "").matchAll(/([a-z]+)\s*[:=]/g)].map((m) => m[1] ?? ""));
    const mMod = modNames(mac, /var MODK = \{([^}]*)\}/);
    const wMod = modNames(win, /\$MODVK=@\{([^}]*)\}/);
    out.push(
      assert(
        "★수식키 스캐너의 눈이 살아 있다 — 양쪽에서 이름이 실제로 모인다",
        mMod.size >= 4 && wMod.size >= 4,
        `mac ${[...mMod].join(",")} · win ${[...wMod].join(",")}`,
      ),
    );
    const modDiff = [...new Set([...mMod, ...wMod])].filter((k) => !mMod.has(k) || !wMod.has(k));
    out.push(
      assert(
        "★★수식키 표의 차이가 **계약에 적힌 그대로**다(PLATFORM_KEY_GAPS) — 말없이 갈리면 발사 도중에 던진다",
        modDiff.length === 1 && modDiff[0] === "win" && !mMod.has("win") && wMod.has("win"),
        `차이: ${modDiff.join(",") || "없음"} (계약: darwin 에 win 없음)`,
      ),
    );

    // ── ★★허용 목록이 **실행부 표와 묶여 있다** (아스트라 재검토 §2·§3) ──────────
    //  ★종전 사전 검증은 **금지 목록**이라 `win` 하나만 막았다 — `f5` 는 양쪽 표 어디에도
    //   없는데 계획을 통과하고 실행부가 **열 한가운데서** 던졌다(앞 step 은 이미 발사됨).
    //   허용 목록으로 뒤집었으니, 이제 그 목록이 **실물과 같은지**를 여기서 잰다.
    // ★★**제품의 목록을 본다 — 사본을 만들지 않는다** (2026-09-19, 아스트라 3차 §3).
    //  종전엔 이 파일 안에 같은 목록을 **베껴** 두고 실행부 표와 비교했다. 그래서
    //  **제품 목록에 `printstreen` 을 더해도 190건이 전부 통과**했다 — 검사와 실행부는
    //  맞는데 **제품만 달라진 것**을 못 본다. 검사에 별도 정본을 만들면 그 순간 셋이 된다.
    const { KEY_NAMES } = await loadPluginModule<{ KEY_NAMES: readonly string[] }>(
      "../../../plugins/computer-use/src/control.ts",
    );
    const missingMac = KEY_NAMES.filter((k) => !m.has(k));
    const missingWin = KEY_NAMES.filter((k) => !w.has(k));
    out.push(
      assert(
        "★★허용 목록의 이름이 **양 실행부 표에 전부 있다** — 없으면 «지원한다» 가 거짓이고 발사 도중에 던진다",
        missingMac.length === 0 && missingWin.length === 0,
        missingMac.length + missingWin.length === 0
          ? `허용 ${String(KEY_NAMES.length)}개 · 양쪽 모두 보유`
          : `mac 없음: ${missingMac.join(",") || "-"} · win 없음: ${missingWin.join(",") || "-"}`,
      ),
    );
    out.push(
      assert(
        "★반대 방향 — 실행부가 아는데 **허용 목록에서 빠진** 이름이 없다(그러면 쓸 수 있는 걸 막는다)",
        [...m].filter((k) => k.length > 1 && !KEY_NAMES.includes(k)).length === 0,
        `mac 표의 여러 글자 이름 중 목록 밖: ${
          [...m].filter((k) => k.length > 1 && !KEY_NAMES.includes(k)).join(",") || "없음"
        }`,
      ),
    );

    return out;
  },
};
