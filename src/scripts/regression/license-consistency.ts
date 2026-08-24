/**
 * 회귀: **배포 라이선스가 한 곳으로 일치한다** (2026-08-07 MIT → Apache-2.0).
 *
 * 라이선스는 **네 자리**에 흩어져 있다 — LICENSE 전문·NOTICE·`package.json` 의 license
 * 필드(sync 가 스크럽으로 채운다)·README 의 라이선스 절(한·영). 하나만 안 바뀌면
 * **배포본이 서로 다른 라이선스를 주장한다** — 법적 문서에서 그건 사소한 불일치가 아니다.
 *
 * ★특히 `package.json` 은 **sync 스킬의 sed 한 줄**이 채운다. 그 줄만 옛 값으로 남으면
 *  LICENSE 파일은 Apache 인데 메타데이터는 MIT 인 상태로 나간다 — npm·GitHub·의존성 스캐너가
 *  전부 메타데이터를 본다. 손으로 관리하는 치환 규칙이라 정확히 드리프트가 나는 부류다.
 *
 * ★과거 릴리스는 MIT 로 남는다(되돌릴 수 없다). 그래서 README 에 "언제부터 바뀌었는지"를
 *  적어두는 것까지가 이 변경의 일부다 — 안 적으면 옛 태그를 받은 사람이 헷갈린다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const SPDX = "Apache-2.0";

export const check: RegressionCheck = {
  name: "license-consistency",
  guards:
    "라이선스가 LICENSE·NOTICE·package.json 스크럽·README 네 자리에 흩어져 서로 다른 것을 주장하던 것",
  run: async (): Promise<Assertion[]> => {
    const { readFile } = await import("node:fs/promises");
    const read = async (rel: string): Promise<string | null> => {
      try {
        return await readFile(new URL(rel, import.meta.url), "utf8");
      } catch {
        return null;
      }
    };
    const O = "../../../_workspace/public-overlay/";
    const [lic, notice, koReadme, enReadme, skill] = await Promise.all([
      read(`${O}LICENSE`),
      read(`${O}NOTICE`),
      // ★랜딩(`README.md`)이 영어다 (2026-08-24) — 변수 이름과 파일이 어긋나면 다음 사람이
      //  반대로 읽는다. 한국어 판정은 `README.ko.md` 를 봐야 한다.
      read(`${O}README.ko.md`),
      read(`${O}README.md`),
      read("../../../.claude/skills/sync-public/SKILL.md"),
    ]);

    // ★배포 레포엔 `_workspace/`·`.claude/` 가 없다(매니페스트 EXCLUDE) — 거기선 대상 아님.
    if (lic === null) {
      return [
        assert("라이선스 일치", true, "배포 레포 — 오버레이 없음(대상 아님)"),
      ];
    }

    const out: Assertion[] = [];
    out.push(
      assert(
        `★LICENSE 가 ${SPDX} 전문이다`,
        lic.includes("Apache License") &&
          lic.includes("Version 2.0, January 2004") &&
          lic.includes("Copyright 2026 tigu77"),
        lic.split("\n")[1]?.trim() ?? "(빈 파일)",
      ),
    );
    out.push(
      assert(
        "NOTICE 가 있고 같은 라이선스를 말한다(Apache 관례 · 귀속 고지)",
        notice !== null && notice.includes("Apache License, Version 2.0"),
        notice === null ? "★NOTICE 없음" : "확인",
      ),
    );
    out.push(
      assert(
        "★sync 스크럽이 package.json 에 같은 SPDX 를 넣는다(메타데이터가 진짜 소비처다)",
        skill !== null && skill.includes(`"license": "${SPDX}"`),
        skill === null
          ? "스킬 없음(대상 아님)"
          : skill.includes(`"license": "${SPDX}"`)
            ? "치환 규칙 일치"
            : "★스크럽이 옛 라이선스를 넣는다",
      ),
    );
    const koOk = koReadme !== null && koReadme.includes("Apache License 2.0");
    const enOk = enReadme !== null && enReadme.includes("Apache License 2.0");
    out.push(
      assert(
        "README(한·영) 라이선스 절이 같은 것을 말한다",
        koOk && enOk,
        `ko=${koOk} en=${enOk}`,
      ),
    );
    out.push(
      assert(
        "★언제부터 바뀌었는지 적혀 있다(옛 태그를 받은 사람이 헷갈리지 않게)",
        koReadme !== null && /v0\.\d+\.\d+ 까지는 MIT/.test(koReadme),
        koReadme !== null && /v0\.\d+\.\d+ 까지는 MIT/.test(koReadme)
          ? "전환 시점 명시"
          : "★전환 시점 미기재",
      ),
    );
    return out;
  },
};
