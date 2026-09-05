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
    // ── ★반대 방향은 «잊었나» 와 «일부러 뺐나» 를 갈라야 한다 (2026-09-05 정태님 지적) ──
    //  종전엔 «목록에 없는 처리기» 를 무조건 **실패**로 냈다. 주석엔 *"내부 전용 이름이
    //  생길 수 있으므로 실패가 아니라 보고로 남긴다"* 고 적어놓고 코드는 `assert` 였다 —
    //  주석과 코드가 어긋나 있었다.
    //  ★그 빨간불이 실제로 사고를 냈다: `/diagnose`(codex 요청 무게 A/B — 결론이 «무게 탓
    //   / 계정 탓» 둘인데 어느 쪽이든 **사용자가 할 수 있는 일이 없다**)를 내가 목록에
    //   추가해 해소했고, **전 사용자 자동완성에 내부 진단이 실려 공개본까지 나갔다.**
    //   검사가 «둘 중 하나를 고르라» 고 하지 않고 한쪽만 초록으로 만들면, 다음 사람은
    //   그 한쪽으로 간다.
    //  ★그래서 판정을 **의도 표시**로 바꾼다. 처리기 옆에 `@unlisted <이름>` 을 적으면
    //   «일부러 뺐다», 없으면 «잊었다». 중앙 목록을 만들지 않으므로 낡지 않고, 결정이
    //   내려진 자리(처리기)에 남는다([[feedback_hand_maintained_lists]]).
    const undocumented = [...handled].filter((h) => !names.includes(h)).sort();
    const declaredUnlisted = new Set(
      [...entry.matchAll(/@unlisted\s+([a-z-]+)/g)].map((m) => m[1] ?? ""),
    );
    const forgotten = undocumented.filter((n) => !declaredUnlisted.has(n));
    out.push(
      assert(
        "★목록에 없는 처리기는 **일부러** 뺀 것이다(`@unlisted` 로 표시) — 안 그러면 사용자는 그 명령을 알 길이 없다",
        forgotten.length === 0,
        forgotten.length === 0
          ? `숨은 명령 ${undocumented.length}개 전부 의도 표시됨${undocumented.length > 0 ? ` (${undocumented.join(", ")})` : ""}`
          : `★표시 없이 숨은 처리기: ${forgotten.join(", ")} — 목록에 넣든지 @unlisted 로 이유를 적어라`,
      ),
    );
    // 반대 오용도 막는다 — 목록에 **있으면서** @unlisted 를 단 것(둘 다면 어느 쪽이 참인지 모른다).
    const contradictory = [...declaredUnlisted].filter((n) => names.includes(n));
    out.push(
      assert(
        "`@unlisted` 를 달고 목록에도 있는 명령이 없다(둘 다면 의도가 두 벌이다)",
        contradictory.length === 0,
        contradictory.length === 0
          ? `@unlisted ${declaredUnlisted.size}개 · 목록과 겹침 0`
          : `★모순: ${contradictory.join(", ")}`,
      ),
    );

    // ── ★핸들러가 **답을 보내나** (2026-09-05 적대 검토) ──────────────────────
    //  사고: `/status` 의 마지막 한 줄(`replyCommand(msg, lines.join("\n"))`)만 지우면
    //  명령이 **완전 침묵**하는데 2,902건이 초록이었다. 소스 정규식들이 찾는 문자열
    //  (`backupInfo()`·`백업:`)은 전부 남아 있으니 핸들러가 «있다» 고 읽은 것이다.
    //  ★그리고 슬래시는 LLM 미경유라 `turn_done` 이 없다 — 답이 없을 뿐 아니라
    //   **대시보드 «작업 중» 이 15분 stale 스윕까지 켜져 있다.**
    //  ★이름을 열거하지 않는다: 파일에서 핸들러를 **파생**하고, 각자 몸통에 송신이
    //   있는지 본다. 새 명령을 더하면 저절로 대상이 된다.
    let slash: string;
    try {
      slash = readFileSync(path.join(REPO, "src/core/entry/slash-commands.ts"), "utf8");
    } catch {
      return out;
    }
    const bodies = [...slash.matchAll(/export const (handle\w+) = async \(/g)].map((m, i, all) => {
      const start = m.index ?? 0;
      const next = i + 1 < all.length ? (all[i + 1]?.index ?? slash.length) : slash.length;
      return [m[1] ?? "", slash.slice(start, next)] as const;
    });
    // 송신 수단 — `replyCommand` 또는 `presentAndClose`(선택지 제시도 답이다).
    const silent = bodies
      .filter(([, body]) => {
        const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        return !/\b(replyCommand|presentAndClose)\s*\(/.test(code);
      })
      .map(([name]) => name);
    out.push(
      assert(
        "핸들러를 파일에서 읽는다(파싱이 죽으면 아래 검사가 무의미하다)",
        bodies.length >= 8,
        `${bodies.length}개: ${bodies.map(([n]) => n).join(", ")}`,
      ),
    );
    out.push(
      assert(
        "★★모든 슬래시 핸들러가 답을 보낸다 — 안 보내면 침묵일 뿐 아니라 대시보드 «작업 중» 이 15분 켜져 있다",
        silent.length === 0,
        silent.length === 0
          ? `${bodies.length}개 전부 송신 있음`
          : `★송신이 없는 핸들러: ${silent.join(", ")}`,
      ),
    );

    // ★위 단언만으론 **모자란다**: 송신이 여럿인 핸들러(성공 + 에러)는 성공 경로만
    //  지워도 통과한다. 실제로 `/status` 가 그 모양이라 첫 판의 변이가 안 걸렸다.
    //  ★그래서 결함 **모양**을 겨눈다: «줄을 모아놓고 안 보낸다». 핸들러가 배열을
    //   쌓아 올렸으면(`.push(`) 그 변수가 송신 인자에 나와야 한다. 안 나오면 그건
    //   만들어놓고 버린 출력이다 — 정확히 그 사고의 형상이다.
    const builtButUnsent: string[] = [];
    for (const [name, body] of bodies) {
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const built = new Set(
        [...code.matchAll(/\b([A-Za-z_$][\w$]*)\.push\(/g)].map((m) => m[1] ?? ""),
      );
      for (const v of built) {
        // 그 변수가 송신 호출의 인자에 등장하나(직접 또는 `.join(...)` 을 거쳐).
        const sent = new RegExp(
          `(?:replyCommand|presentAndClose)\\s*\\([^)]*\\b${v}\\b`,
        ).test(code);
        if (!sent) builtButUnsent.push(`${name}.${v}`);
      }
    }
    out.push(
      assert(
        "★★모아 올린 줄이 실제로 나간다 — 만들어놓고 안 보내면 «답이 없다» 로만 드러나고, 소스 검사는 내용이 남아 있어 통과한다",
        builtButUnsent.length === 0,
        builtButUnsent.length === 0
          ? `누적 변수 전부 송신 인자에 도달`
          : `★쌓았는데 안 보내는 것: ${builtButUnsent.join(", ")}`,
      ),
    );

    return out;
  },
};
export default check;
