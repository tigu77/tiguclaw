/**
 * 회귀: **목록에 있는 명령은 실제로 처리된다** (2026-09-05 구조 감사 ⑤).
 *
 * 슬래시 명령은 **두 곳**에서 산다 — 이름·설명 목록(`core/entry/command-registry.ts`, 자동완성과
 * 도움말이 읽는다)과 실제 처리(`src/index.ts`: 직렬 핸들러 안의 `/` 블록 + 그 밖의
 * **아웃오브밴드** 셋). 두 곳이 갈리면 조용하다: 목록에만 있는 이름은 자동완성에 뜨고,
 * 사용자가 치면 **아무 일도 안 일어난다**(혹은 «모르는 명령» 도 아니고 그냥 메시지가 된다).
 *
 * 감사 시점엔 안 갈려 있었다(17종 = 인밴드 14 + 아웃오브밴드 3). 그런데 **그걸 지키는 검사가
 * 없었다** — 이 레포에서 «지금은 맞는데 그물이 없는» 것이 조용히 갈린 전례가 여럿이다
 * (인벤토리 도구 목록·프록시 분기·모바일 뷰 목록). 그래서 지금 못 박는다.
 *
 * ★이름을 열거하지 않는다: 목록은 레지스트리에서 **파생**하고, 처리 여부는 소스에서 찾는다.
 *  새 명령을 더하면 저절로 대상이 된다([[feedback_hand_maintained_lists]]).
 * ★등급: 배선 린트. «처리기가 있다» 까지만 본다 — 그 처리기가 옳게 도는지는 각 명령의
 *  자기 회귀(`/sessions`·`/stop` 등)가 본다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const check: RegressionCheck = {
  name: "commands-have-handlers",
  guards:
    "명령 목록(자동완성·도움말)에만 있고 처리기가 없는 이름이 생기면, 사용자가 쳐도 아무 일이 안 일어나던 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    let registry: string;
    let entry: string;
    try {
      registry = readFileSync(path.join(REPO, "src/core/entry/command-registry.ts"), "utf8");
      entry = readFileSync(path.join(REPO, "src/index.ts"), "utf8");
    } catch {
      return [assert("소스 없음(배포 레포 아님)", true, "건너뜀")];
    }

    // 목록은 **정의점에서 파생**한다.
    const names = [...registry.matchAll(/\{ name: "([a-z-]+)"/g)].map((m) => m[1] ?? "");
    out.push(
      assert(
        "명령 목록을 레지스트리에서 읽는다(파싱이 죽으면 이 검사는 무의미하다)",
        names.length >= 10,
        `${names.length}종: ${names.slice(0, 8).join(", ")}…`,
      ),
    );
    if (names.length === 0) return out;

    // 처리 흔적 — 인밴드(`cmd === "/x"`)와 아웃오브밴드(`trimmed === "/x"`) 둘 다 본다.
    // ★주석은 걷는다: 결함을 설명한 글을 코드로 세면 «있다» 고 오판한다(이 레포 상습 부류).
    const code = entry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const handled = new Set<string>();
    for (const re of [
      /cmd === "\/([a-z-]+)"/g,
      /trimmed(?:\.toLowerCase\(\))? === "\/([a-z-]+)"/g,
      /trimmed\.startsWith\("\/([a-z-]+) ?"\)/g,
      /cmd\.startsWith\("\/([a-z-]+)/g,
      // ★아웃오브밴드 셋(/restart·/stop·/update)은 **직렬 핸들러 밖**에서 잡힌다 — 문법이
      //  다르다(`msg.text.trim() === "/x"`). 첫 판이 이 패턴을 빠뜨려 셋을 «처리기 없음» 으로
      //  보고했다. 검사가 한 문법만 알면 그건 코드가 아니라 검사의 시야 문제다.
      /msg\.text\.trim\(\) === "\/([a-z-]+)"/g,
    ]) {
      for (const m of code.matchAll(re)) handled.add(m[1] ?? "");
    }

    const orphans = names.filter((n) => !handled.has(n));
    out.push(
      assert(
        "★목록의 모든 명령에 처리기가 있다(없으면 자동완성에 뜨고 아무 일도 안 일어난다)",
        orphans.length === 0,
        orphans.length === 0
          ? `${names.length}종 전부 처리됨(인밴드+아웃오브밴드 ${handled.size}종 발견)`
          : `★처리기 없는 명령: ${orphans.join(", ")}`,
      ),
    );

    // 반대 방향도 본다 — 처리하는데 목록에 없으면 **사용자가 그 명령을 알 길이 없다**.
    // (내부 전용 이름이 생길 수 있으므로 실패가 아니라 «보고» 로 남긴다.)
    const undocumented = [...handled].filter((h) => !names.includes(h)).sort();
    out.push(
      assert(
        "처리하는데 목록에 없는 명령이 없다(있으면 사용자는 그 명령을 알 길이 없다)",
        undocumented.length === 0,
        undocumented.length === 0 ? "숨은 명령 0" : `★목록에 없는 처리기: ${undocumented.join(", ")}`,
      ),
    );

    return out;
  },
};
export default check;
