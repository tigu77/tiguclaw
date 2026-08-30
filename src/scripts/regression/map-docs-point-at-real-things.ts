/**
 * 회귀: **지도 문서가 실재하는 것을 가리킨다** (2026-08-30 구조 검토).
 *
 * 사고랄 것은 없다 — 대신 **죽은 게이트**가 있었다. `code-map.md`·`core-boundaries.md` 는
 * 신규 합류자가 코드를 처음 만나는 자리인데, 머리말이 *"기준 커밋 이후 100커밋을 넘으면
 * 밀린 걸로 보고 대조하라"* 는 스테일 규칙을 **스스로** 적어뒀다. 사람이 손으로 돌리는
 * 게이트였고, 아무도 안 돌렸다:
 *
 * ```
 * 기준 커밋 이후 549커밋 (임계 100의 5.5배)
 * 줄번호 주장 13건 → 맞음 0 · 틀림 8 · 함수 못 찾음 5
 * 밀림 폭 14 ~ 245줄
 * ```
 *
 * ★**고침은 줄번호를 갱신하는 게 아니라 없애는 것이었다.** 549커밋마다 손으로 맞출 게
 *  아니면 그 좌표는 태어날 때부터 썩는다. 남긴 것은 **안 썩는 좌표**뿐이다 — 파일 경로와
 *  심볼 이름. 리팩터로 줄이 움직여도 따라가고, `grep` 한 줄로 찾힌다.
 *
 * ★그리고 판정을 **자동으로 도는 자리**로 옮겼다 — 그게 이 파일이다
 *  ([[feedback_gate_must_actually_run]]). 손으로 돌리는 게이트는 있으나 마나다.
 *
 * 지키는 것 셋:
 *  ① 문서가 말하는 **파일 경로**가 실재한다(옮기거나 지우면 여기서 운다).
 *  ② 문서가 말하는 **심볼**이 그 코드베이스에 실재한다(개명하면 운다).
 *  ③ ★**썩는 좌표가 다시 안 들어온다** — `함수()(L174)`·`index.ts:1925` 형식 0건.
 *     이게 없으면 다음 사람이 친절하게 줄번호를 도로 달고, 그 순간 같은 부패가 시작된다.
 *
 * 등급: 전부 **실재 대조**(파일시스템·소스 grep). 문자열 존재 검사가 아니라 "가리키는
 * 것이 있는가" 를 묻는다.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCS = ["docs/code-map.md", "docs/core-boundaries.md"];

/** 코드베이스 전체를 한 문자열로 — 심볼이 **어딘가에** 있으면 된다(어느 줄인지는 안 묻는다). */
const allSource = (): string => {
  const parts: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(name)) parts.push(readFileSync(p, "utf8"));
    }
  };
  for (const root of ["src", "plugins", "packages"]) walk(path.join(REPO, root));
  return parts.join("\n");
};

export const check: RegressionCheck = {
  name: "map-docs-point-at-real-things",
  guards:
    "신규 합류자가 처음 읽는 지도 문서가 없는 파일·없는 심볼을 가리키는 것 + 줄번호처럼 **태어날 때부터 썩는 좌표**가 다시 들어오는 것(종전 판은 549커밋 뒤 줄번호 13건 중 맞는 게 0건이었고, 그걸 지키는 게이트는 사람이 손으로 돌리는 것이라 아무도 안 돌렸다)",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const src = allSource();

    for (const rel of DOCS) {
      const full = path.join(REPO, rel);
      out.push(
        assert(`${rel} 이 실재한다(없으면 아래 검사가 조용히 공짜로 통과한다)`, existsSync(full), full),
      );
      if (!existsSync(full)) continue;
      const doc = readFileSync(full, "utf8");

      // ── ① 파일 경로 ──────────────────────────────────────────────────────
      // ★이름을 열거하지 않는다 — 문서에서 **경로 모양**을 뽑아 대조한다.
      const paths = [
        ...new Set(
          [...doc.matchAll(/`((?:src|plugins|packages|bin|docs|skills)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g)].map(
            (m) => m[1]!,
          ),
        ),
      ];
      // ★배포본에 없는 것(`docs/architecture.md` 등)은 dev 레포엔 있으므로 그대로 대조된다.
      // ★**없어도 되는 경우가 하나 있다: 문서가 그렇게 적어둔 것.** `docs/architecture.md`·
      //  `docs/decisions/` 는 배포본에서 빠지고, `code-map.md` 는 *"그 둘은 배포본에 없다"*
      //  고 **명시**한다. 그건 거짓 안내가 아니라 정확한 안내다.
      //
      //  ★그래도 **조용히 통과시키지는 않는다** — 근처에 그 사실이 적혀 있어야 넘어간다.
      //  이름 목록을 두면 새로 빠지는 파일마다 검사를 고쳐야 하고, 아무 조건 없이 넘기면
      //  진짜 끊긴 링크까지 새어 나간다. **문서가 말하게 하는 것**이 판정이다
      //  (2026-08-30, 배포 트리 회귀가 잡았다).
      const annotatedAbsent = (ref: string): boolean => {
        const at = doc.indexOf(ref);
        if (at < 0) return false;
        return /배포본에 없다|not in the distribution/.test(doc.slice(Math.max(0, at - 300), at + 300));
      };
      const gone = paths.filter(
        (p) => !existsSync(path.join(REPO, p)) && !annotatedAbsent(p),
      );
      out.push(
        assert(
          `★${rel} 이 말하는 파일 경로가 전부 실재한다 — 옮기거나 지우면 신규 합류자가 없는 파일을 찾는다`,
          gone.length === 0,
          gone.length === 0 ? `${String(paths.length)}개 경로 전부 실재` : `★없음: ${gone.join(", ")}`,
        ),
      );

      // ── ② 심볼 ──────────────────────────────────────────────────────────
      // 백틱 안의 `함수()` 표기만 본다 — 산문 속 단어를 심볼로 오해하지 않게.
      const syms = [
        ...new Set([...doc.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]{3,})\(\)`/g)].map((m) => m[1]!)),
      ];
      const missing = syms.filter((s) => !new RegExp(`\\b${s}\\b`).test(src));
      out.push(
        assert(
          `★${rel} 이 말하는 심볼이 코드에 실재한다 — 개명하면 문서가 조용히 거짓이 된다(${String(syms.length)}개 대조)`,
          missing.length === 0,
          missing.length === 0 ? `${String(syms.length)}개 심볼 전부 실재` : `★없음: ${missing.join(", ")}`,
        ),
      );

      // ── ③ 썩는 좌표가 다시 안 들어온다 ────────────────────────────────────
      const rotting = [
        ...doc.matchAll(/\(L\d{2,4}\b|\b[A-Za-z0-9_.-]+\.(?:ts|js):\d+/g),
      ].map((m) => m[0]);
      out.push(
        assert(
          `★★${rel} 에 **줄번호가 없다** — 줄번호는 커밋 한 번에 밀리는 좌표라 태어날 때부터 썩는다(종전 판: 549커밋 뒤 13건 중 맞는 것 0건). 파일·심볼만 적어라`,
          rotting.length === 0,
          rotting.length === 0 ? "줄번호 0건" : `★${String(rotting.length)}건: ${rotting.slice(0, 6).join(", ")}`,
        ),
      );
    }

    return out;
  },
};
