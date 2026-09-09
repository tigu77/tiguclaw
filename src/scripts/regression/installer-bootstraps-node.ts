/**
 * 회귀: **Node 가 없어도 설치가 끝난다 — 단, 시스템은 안 건드린다** (2026-09-09 정태님:
 * *"빠른 설치에서 노드가 없으면 자동으로 설치 가능해?"* · *"일반 사용자들도 설치하기
 * 시작했거든"*).
 *
 * 종전엔 두 설치기가 Node 가 없으면 **안내하고 멈췄다**. 제품 정체성이 «당신의 상시 AI
 * 비서» 인데(개발자가 아니다), «먼저 Node 20 이상을 설치하세요» 는 거기서 벽이다.
 * 셸/PowerShell 로 도니 닭-달걀은 원래 없었다 — 안 하기로 했던 것뿐이다.
 *
 * ★**시스템 패키지 관리자를 부르지 않는다.** `brew install node`·`apt install`·
 *  `winget install` 은 전역 변경이고 관리자 권한이 필요할 수 있으며, 무엇보다 **지울 때
 *  같이 안 지워진다.** 앱 폴더 안 `.node` 가 판정 3줄을 만족한다 — 지울 때 같이 지워지고 ·
 *  깨질 때 혼자 깨지고 · 폴더만 보면 누구 것인지 안다
 *  ([[feedback_external_things_own_their_unit]]).
 * ★**체크섬 검증은 협상 대상이 아니다** — 실행 파일을 받는다. 검증 없이 푸는 갈래가
 *  생기면 그건 설치기가 아니라 공격 표면이다.
 * ★버전을 **손으로 박지 않는다**: `latest-v<major>.x/SHASUMS256.txt` 가 파일 이름과 해시를
 *  같이 준다. 박아두면 낡고, 낡은 줄은 아무도 안 고친다([[feedback_hand_maintained_lists]]).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(path.join(REPO, rel), "utf8");
/**
 * 두 가지 시선이 필요하다 — 한 벌로는 둘 다 틀린다.
 *
 * ★`code`  = 주석만 걷는다. **«불일치면 중단하나»** 는 `Die`/`die` 토큰이 있어야 보인다.
 * ★`bare`  = 주석 + **문자열 내용**까지 비운다. **«전역 설치를 부르나»** 는 문자열 안의
 *   `winget install …` 이 걸리면 안 된다 — 그건 호출이 아니라 «직접 깔려면 이 명령을
 *   쓰세요» 라는 **안내**다.
 *
 * ★첫 판은 `Die` 가 든 줄을 통째로 버려 안내를 피하려 했는데, **중단하는 줄도 같이
 *  사라졌다**(`if ($got -ne $want) { Die … }`). 그 다음 판은 해시 도구 낱말 존재만 봐서
 *  **비교문을 지워도 초록**이었다(변이로 실측). 판정 대상은 «실행되는 코드» 이고,
 *  질문마다 봐야 할 면이 다르다 — 한 벌로 뭉치면 둘 중 하나는 반드시 틀린다.
 */
const code = (s: string): string =>
  s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const bare = (s: string): string =>
  code(s).replace(/"[\s\S]*?"/g, '""').replace(/'[^'\n]*'/g, "''");

export const check: RegressionCheck = {
  name: "installer-bootstraps-node",
  guards:
    "Node 가 없으면 설치가 멈추던 것 — 일반 사용자에겐 그게 벽이다. 대신 앱 폴더 안에 " +
    "전용 Node 를 받되, 시스템 패키지 관리자는 부르지 않고 체크섬을 반드시 검증한다",
  async run(): Promise<Assertion[]> {
    const sh = code(read("install.sh"));
    const ps = code(read("install.ps1"));
    const shBare = bare(read("install.sh"));
    const psBare = bare(read("install.ps1"));
    const out: Assertion[] = [];

    for (const [name, src, srcBare] of [
      ["install.sh", sh, shBare],
      ["install.ps1", ps, psBare],
    ] as const) {
      const dl = /nodejs\.org\/dist\/latest-v/;
      out.push(
        assert(
          `★★${name}: Node 가 없을 때 **받아서 잇는다** — 안내하고 멈추면 개발자가 아닌 사용자는 거기서 끝난다`,
          dl.test(src),
          dl.test(src) ? "공식 배포본 조회 있음" : "★조회 경로 없음(멈추기만 한다)",
        ),
      );
      // 해시 대조 — **낱말이 있나가 아니라 그 비교가 중단시키나**를 본다.
      //  ★첫 판은 `/sha256sum|Get-FileHash/` 존재만 봤다. 그래서 비교문을 통째로 지우고
      //   해시를 안 쓰는 변수에 담기만 해도 **초록이었다**(변이로 실측). 검증이 사라졌는데
      //   게이트가 «검증한다» 고 답하면 그건 없는 검사다([[feedback_gate_must_actually_run]]).
      const hasTool = /sha256sum|shasum -a 256|Get-FileHash/.test(src);
      const hasList = /SHASUMS256/.test(src);
      // 계산한 값과 공표된 값을 맞대고, 다르면 죽는다.
      const aborts =
        /\$_got"?\s*=\s*"?\$_want[\s\S]{0,120}?\bdie\b/.test(src) ||
        /\$got\s+-ne\s+\$want[\s\S]{0,160}?\bDie\b/.test(src);
      out.push(
        assert(
          `★★${name}: 받은 것을 **체크섬으로 검증하고, 다르면 중단한다** — 실행 파일을 받는 중이고, 검증 없는 갈래는 설치기가 아니라 공격 표면이다`,
          hasTool && hasList && aborts,
          `해시도구=${hasTool} · SHASUMS=${hasList} · 불일치시중단=${aborts}`,
        ),
      );
      // 시스템 전역 설치를 부르지 않는다.
      // ★문자열을 비운 면으로 본다 — 안내 문구 속 명령은 호출이 아니다.
      const globalInstall = /(brew|apt-get|apt|dnf|yum)\s+install\s+[^\n]*node|winget\s+install\s+[^\n]*NodeJS/i.test(srcBare);
      out.push(
        assert(
          `★${name}: **시스템 패키지 관리자로 Node 를 깔지 않는다** — 전역 변경은 지울 때 같이 안 지워지고 관리자 권한을 부를 수 있다`,
          !globalInstall,
          globalInstall ? "★전역 설치 호출이 있다" : "전역 설치 호출 0",
        ),
      );
      // 받는 자리가 설치 폴더 안이어야 한다(홈·시스템이 아니라).
      const insideAppDir = /(\$DIR|\$Dir)[/\\]?['"]?\.node|Join-Path \$Dir '\.node'/.test(src);
      out.push(
        assert(
          `★${name}: 전용 Node 를 **설치 폴더 안**(\`.node\`)에 둔다 — 폴더를 지우면 같이 사라져야 «자기 관리 단위» 가 된다`,
          insideAppDir,
          insideAppDir ? "설치 폴더 하위" : "★설치 폴더 밖이다",
        ),
      );
    }

    // 버전을 손으로 박지 않았나 — `latest-v<major>.x` 는 되지만 `v22.23.2` 같은 못은 안 된다.
    const pinned = /nodejs\.org\/dist\/v\d+\.\d+\.\d+/.test(sh + ps);
    out.push(
      assert(
        "★특정 Node 버전을 URL 에 못박지 않는다 — 박아두면 낡고, 낡은 줄은 아무도 안 고친다(LTS 계열만 고르고 나머지는 공식 목록이 정한다)",
        !pinned,
        pinned ? "★고정 버전 URL 있음" : "계열만 지정",
      ),
    );
    return out;
  },
};
