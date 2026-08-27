/**
 * 회귀: **업데이트 전에 무엇이 바뀌는지 볼 수 있다** (2026-08-27).
 *
 * ★사용자 지적: *"업데이트 버튼만 달랑 있으니까 변경 내역을 확인하기가 힘든데."* 맞았다 —
 *  종전엔 **받아봐야 알았다.**
 *
 * ★그런데 데이터는 이미 손안에 있었다. 판정이 어차피 `git fetch` 를 돌리는데(그래야 몇 커밋
 *  뒤처졌는지 안다), fetch 는 원격 오브젝트를 **다운로드까지** 한다 — 작업트리만 안 건드린다.
 *  실증(뒤처진 클론): `origin/main` ref 를 지우면 `git show` 가 실패하고, `fetch` 만 하면
 *  작업트리는 0.40.0 인 채로 원격 0.40.1 항목이 읽히며, **프록시를 막아도** 읽힌다.
 *  ★첫 실증은 이미 최신인 레포에서 해서 아무것도 증명하지 못했다(사용자가 짚어줬다) —
 *  그래서 이 검사는 **뒤처진 상태를 만들어서** 본다.
 *
 * 지키는 것 셋:
 *  ① **잘라내기가 맞는가** — 내 버전보다 위인 것만, 상한까지만, 나머지는 개수로 정직하게.
 *  ② **없을 때 조용한가** — CHANGELOG 가 없는 설치(dev 레포가 그렇다)에서도 칩은 정상.
 *  ③ **화면이 그걸 쓰는가** — 백엔드가 실어도 대화상자가 안 보여주면 사용자에겐 없는 것이다.
 *
 * 등급: **동작 검사** — 파서·포맷터를 실제로 부른다(포맷터는 IIFE 라 `vm` 으로 떼어 쓴다).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { changelogSince } from "../../core/update-availability.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** 진짜 CHANGELOG 모양(우리 파일에서 뜬 형태). 지어낸 픽스처가 아니다. */
const BODY = `# Changelog

## [Unreleased]

## [0.41.0] - 2026-08-27

### Added

- **새 기능 하나.** 설명 \`코드\` 와 **굵게**.

## [0.40.1] - 2026-08-27

### Fixed

- 고친 것.

## [0.40.0] - 2026-08-27

### Added

- 옛 것.
`;

/** IIFE 안의 순수 함수만 떼어 vm 에서 실제로 부른다(대시보드 JS 는 import 불가). */
const sliceFormatter = (src: string): string => {
  const from = src.indexOf("      const formatUpdateNotes = (notes, maxChars");
  const end = src.indexOf("\n      };", from);
  if (from < 0 || end < 0) throw new Error("formatUpdateNotes 정의를 못 찾음 — 구조가 바뀌었나");
  return src.slice(from, end + "\n      };".length);
};

export const check: RegressionCheck = {
  name: "update-notes-are-visible",
  guards:
    "업데이트 칩이 '있다'만 말하고 무엇이 바뀌는지는 받아봐야 알던 것 — fetch 로 이미 받아둔 원격 CHANGELOG 를 안 읽고 있었다 + 그 내용이 백엔드에만 실리고 확인 대화상자엔 안 나오던 것",
  run: async (): Promise<Assertion[]> => {
    const chip = readFileSync(
      path.join(REPO, "packages/dashboard/js/update-chip.js"),
      "utf8",
    );
    const core = readFileSync(path.join(REPO, "src/core/update-availability.ts"), "utf8");

    // ── ① 잘라내기 ──
    const from040 = changelogSince(BODY, "0.40.0");
    const from041 = changelogSince(BODY, "0.40.1");
    const latest = changelogSince(BODY, "0.41.0");
    const capped = changelogSince(BODY, "0.39.0", 1);
    const unknown = changelogSince(BODY, undefined);

    // ── ③ 포맷터를 vm 에서 실제로 부른다 ──
    const ctx: Record<string, unknown> = {
      i18n: (k: string, p?: Record<string, unknown>) =>
        `<${k}${p !== undefined ? `:${JSON.stringify(p)}` : ""}>`,
    };
    vm.createContext(ctx);
    vm.runInContext(`${sliceFormatter(chip)}\nthis.__f = formatUpdateNotes;`, ctx);
    const fmt = ctx.__f as (n: unknown, max?: number) => string;
    const rendered = fmt(from040);
    const empty = fmt(undefined) + fmt(null) + fmt({ sections: [], omitted: 0 });
    const truncated = fmt(from040, 20);

    // ★**실제 CHANGELOG 로 태운다** (2026-08-27 적대 검토 F2). 픽스처가 한 줄짜리 굵게만
    //  담아서 `!/\*\*/.test(rendered)` 가 통과했는데, 진짜 파일엔 **줄바꿈을 넘는 굵게**가
    //  있어 `.` 이 못 먹고 `**` 가 그대로 남았다 — 사용자가 볼 본문에 2개, 파일 전체엔 13줄.
    // ★배포본엔 **루트**에 있고 개발 레포엔 **오버레이 안**에 있다 — 둘 다 본다.
    //  (첫 판은 오버레이만 읽어서 **배포 트리에서만** 터졌다. `_workspace/` 는 공개 제외라
    //   그 트리엔 없다 — 릴리스 게이트가 잡았다.)
    const realBody = (() => {
      for (const rel of ["CHANGELOG.md", "_workspace/public-overlay/CHANGELOG.md"]) {
        try {
          return readFileSync(path.join(REPO, rel), "utf8");
        } catch {
          /* 다음 자리 */
        }
      }
      return "";
    })();
    const realCut = changelogSince(realBody, "0.40.1");
    const real = fmt(realCut);
    if (realBody === "") {
      return [
        assert(
          "★실제 CHANGELOG 를 찾았다(못 찾으면 아래가 전부 미검사다)",
          false,
          `찾은 곳 없음 — 시도: ${["CHANGELOG.md", "_workspace/public-overlay/CHANGELOG.md"].join(", ")} (기준 ${REPO})`,
        ),
      ];
    }

    return [
      assert(
        "★실제 CHANGELOG 에서 마크다운 장식이 남지 않는다(픽스처가 아니라 진짜 파일로)",
        real !== "" && !/\*\*/.test(real) && !/`/.test(real),
        `길이 ${real.length} · ** ${(real.match(/\*\*/g) ?? []).length}개 · 백틱 ${(real.match(/`/g) ?? []).length}개`,
      ),
      assert(
        "★영문 섹션 헤더가 한국어 대화상자에 남지 않는다",
        !/^(Added|Changed|Fixed|Removed|Deprecated|Security)$/m.test(real),
        [...real.matchAll(/^(Added|Changed|Fixed|Removed|Deprecated|Security)$/gm)]
          .map((m) => m[1])
          .join(",") || "0건",
      ),
      assert(
        "★자를 땐 **줄 경계**에서 자른다(문장 한가운데서 끊지 않는다)",
        (() => {
          const cutSet = changelogSince(realBody, "0.3.0");
          // ★상한을 **명시로** 낮춰 자르기를 강제한다. 첫 판은 기본 상한(2400)에 기댔는데
          //  실제 본문이 2,257자라 **안 잘렸고**, 그래서 단언이 항상 거짓이었다 —
          //  코드가 아니라 입력을 안 본 것이다.
          const long = fmt(cutSet, 1200);
          if (!long.includes("upd.notesTruncated")) return false;
          // ★판정은 "**포맷된** 전문과 견줘 줄 경계에서 끊겼나" 다. 첫 판은 변환된 텍스트
          //  (`- `→`• `, 굵게 제거)를 **원본 파일**과 대조해서 항상 실패했다 — 비교 대상이
          //  틀렸던 것이지 코드가 틀린 게 아니었다.
          const full = fmt(cutSet, Number.MAX_SAFE_INTEGER);
          const body = long.slice(0, long.lastIndexOf("\n\n"));
          return full.startsWith(body) && full[body.length] === "\n";
        })(),
        JSON.stringify(fmt(changelogSince(realBody, "0.3.0"), 1200).slice(-110)),
      ),
      assert(
        "★내 버전보다 **위**인 것만 싣는다(이미 가진 걸 다시 보여주지 않는다)",
        from040.sections.map((s) => s.version).join(",") === "0.41.0,0.40.1",
        from040.sections.map((s) => s.version).join(",") || "(없음)",
      ),
      assert(
        "★한 칸 위면 그 하나만",
        from041.sections.map((s) => s.version).join(",") === "0.41.0",
        from041.sections.map((s) => s.version).join(",") || "(없음)",
      ),
      assert(
        "★최신이면 빈손(칩이 떠도 보여줄 게 없으면 아무 말 안 한다)",
        latest.sections.length === 0,
        `${latest.sections.length}건`,
      ),
      assert(
        "★상한을 넘으면 자르고 **몇 개 생략했는지 말한다**(조용히 삼키지 않는다)",
        capped.sections.length === 1 && capped.omitted === 2,
        `실린 ${capped.sections.length} · 생략 ${capped.omitted}(기대 1/2)`,
      ),
      assert(
        "★버전을 모르면 최신 1개만(모르면서 다 아는 척하지 않는다)",
        unknown.sections.length === 1 && unknown.sections[0]?.version === "0.41.0",
        `${unknown.sections.length}건 · ${unknown.sections[0]?.version}`,
      ),
      assert(
        "★`[Unreleased]` 는 버전이 아니다(항목으로 새지 않는다)",
        !BODY.includes("## [Unreleased]") ||
          changelogSince(BODY, "0.1.0").sections.every((s) => /^\d/.test(s.version)),
        changelogSince(BODY, "0.1.0").sections.map((s) => s.version).join(","),
      ),
      // ── 포맷터 ──
      assert(
        "★마크다운 장식을 걷어낸다(confirm 은 평문만 받는다)",
        !/\*\*/.test(rendered) && !/`/.test(rendered) && rendered.includes("• "),
        JSON.stringify(rendered.slice(0, 80)),
      ),
      assert(
        "★자를 땐 **잘랐다고 말한다**",
        truncated.includes("upd.notesTruncated"),
        JSON.stringify(truncated.slice(-60)),
      ),
      assert(
        "★붙일 게 없으면 빈 문자열(호출부가 종전 문구를 그대로 쓴다)",
        empty === "",
        JSON.stringify(empty),
      ),
      // ── ② 배선: 백엔드가 싣고, 화면이 쓴다 ──
      assert(
        "★코어가 원격 CHANGELOG 를 **pull 없이** 읽는다 + **두 자리를** 본다",
        /git\(\[\s*"show",\s*`@\{u\}:\$\{rel\}`\]/.test(core) &&
          /"CHANGELOG\.md"/.test(core) &&
          /"_workspace\/public-overlay\/CHANGELOG\.md"/.test(core),
        // ★개발 레포는 정본이 오버레이 안이라, 루트만 보면 **요청자의 화면에서 안 뜬다**
        //  (적대 검토 F4 — 실제로 그랬다).
        `@{u} 사용=${/`@\{u\}:\$\{rel\}`/.test(core)} · 루트=${/"CHANGELOG\.md"/.test(core)} · 오버레이=${/public-overlay\/CHANGELOG\.md"/.test(core)}`,
      ),
      assert(
        "★못 읽어도 칩은 뜬다(변경 내역은 부가 정보다)",
        /catch \{[\s\S]{0,120}?\}\s*\n\s*return \{ state: "available"/.test(core),
        /notes !== undefined \? \{ notes \}/.test(core) ? "옵션으로 실림" : "★필수처럼 다룬다",
      ),
      assert(
        "★확인 대화상자가 그 내용을 보여준다(백엔드에만 있으면 사용자에겐 없는 것)",
        /formatUpdateNotes\(current\.notes\)/.test(chip) &&
          /window\.confirm\(ask\)/.test(chip),
        `포맷 호출=${/formatUpdateNotes\(current\.notes\)/.test(chip)} · confirm 에 전달=${/window\.confirm\(ask\)/.test(chip)}`,
      ),
    ];
  },
};
