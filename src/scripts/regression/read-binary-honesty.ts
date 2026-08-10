/**
 * 회귀: 텍스트가 아닌 파일을 **텍스트인 척 성공으로 돌려주지 않는다.**
 *
 * 사고 계보 — 같은 병을 두 번 앓았다:
 *  ① 2026-08-01: JPEG 을 `readFile(utf8)` 로 읽어 깨진 글자를 **성공으로** 반환했다.
 *     "모델은 판독 불가라 답하는데 호출한 앱은 정상 응답으로 받아 캐시에 저장했다 —
 *     사흘간 캐시 오염으로 세 번 오진했다." 그때 **이미지만** 고쳤다.
 *  ② 2026-08-10: 나머지 바이너리(APK·실행파일·zip·폰트…)는 구멍이 그대로였다.
 *     사용자 질문("모르는 파일이 나오면 어떻게 되지? APK 같은 거")에서 드러났다.
 *
 * ★핵심은 "못 다룬다" 가 아니라 **"막혔다는 걸 모른다"** 다. Bash 라는 만능 우회로가 있어
 *  능력은 충분한데, 판독 실패가 실패로 보고되지 않으면 **그 우회로로 갈 계기가 안 생긴다.**
 *  그래서 응답이 해야 할 일은 셋이다 — 텍스트가 아님을 말하고 · 진단 수치(경로·크기)를 주고 ·
 *  다른 도구를 찾으라고 알린다. 도구 목록은 박지 않는다(파일마다 다르고, 목록은 드리프트한다).
 *
 * 지키는 것 — ①바이너리를 바이너리로 본다 ②텍스트를 오탐하지 않는다 ③**이미지가 먼저**다
 *  (이미지는 비전 채널로 가야지 "텍스트 아님" 으로 끝나면 능력이 줄어든다) ④응답이 다음
 *  행동을 알린다.
 */
import { readFileSync } from "node:fs";
import { looksBinary } from "../../core/llm-runtime/capabilities/file-ops-mcp.js";
import type { Assertion, RegressionCheck } from "./_framework.js";

const buf = (s: string): Buffer => Buffer.from(s, "utf8");

const run = async (): Promise<Assertion[]> => {
  const out: Assertion[] = [];

  // ── ① 바이너리를 바이너리로 본다 ───────────────────────────────────────────
  {
    const nul = Buffer.concat([buf("MZ"), Buffer.from([0x00, 0x00, 0x01]), buf("rest")]);
    // APK/zip 헤더(PK\x03\x04) — NUL 이 바로 나온다.
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
    // ELF
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    const cases: [string, Buffer][] = [
      ["NUL 포함", nul],
      ["zip/APK 헤더", zip],
      ["ELF 실행파일", elf],
    ];
    const bad = cases.filter(([, b]) => !looksBinary(b)).map(([n]) => n);
    out.push({
      name: "★바이너리를 텍스트로 착각하지 않는다",
      ok: bad.length === 0,
      got: bad.length === 0 ? `${cases.length}종 전부 binary 판정` : `놓침: ${bad.join(", ")}`,
    });
  }

  // ── ② 텍스트를 오탐하지 않는다(한글·이모지·긴 줄 포함) ─────────────────────
  //  오탐하면 멀쩡한 파일을 못 읽게 되고, 그건 이 수정이 만든 새 결함이 된다.
  {
    const cases: [string, Buffer][] = [
      ["ASCII", buf("hello world\nconst a = 1;\n")],
      ["한글", buf("안녕하세요 — 티구클로입니다.\n줄바꿈도 있습니다.\n")],
      ["이모지", buf("배포 완료 ✅ 회귀 774건 🎉\n")],
      ["빈 파일", Buffer.alloc(0)],
      ["JSON", buf(JSON.stringify({ a: 1, b: "가나다" }))],
    ];
    const bad = cases.filter(([, b]) => looksBinary(b)).map(([n]) => n);
    out.push({
      name: "텍스트를 바이너리로 오탐하지 않는다(한글·이모지 포함)",
      ok: bad.length === 0,
      got: bad.length === 0 ? `${cases.length}종 전부 text 판정` : `오탐: ${bad.join(", ")}`,
    });
  }

  // ── ③ ★이미지는 **먼저** 처리된다 — 순서가 곧 능력이다 ─────────────────────
  //  이미지도 바이너리라 판정만 보면 true 다. 그런데 "텍스트 아님" 으로 끝나면 비전으로
  //  보내던 능력이 사라진다(원칙 1 "슈퍼셋 — 누락은 버그"). 소스에서 순서를 고정한다.
  {
    const src = readFileSync(
      new URL("../../core/llm-runtime/capabilities/file-ops-mcp.ts", import.meta.url),
      "utf8",
    );
    const imgAt = src.indexOf("const imageMime = sniffImageMime(headBuf)");
    const binAt = src.indexOf("if (looksBinary(headBuf))");
    out.push({
      name: "★이미지 판정이 바이너리 판정보다 앞이다(비전 능력 보존)",
      ok: imgAt > 0 && binAt > 0 && imgAt < binAt,
      got: `이미지 idx=${imgAt} 바이너리 idx=${binAt} (기대 이미지 < 바이너리)`,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    out.push({
      name: "(참고) 이미지도 바이너리로는 판정된다 — 그래서 순서가 중요하다",
      ok: looksBinary(png),
      got: `png looksBinary=${looksBinary(png)}`,
    });
  }

  // ── ④ 응답이 **다음 행동**을 알린다 ────────────────────────────────────────
  //  "못 읽음" 만 말하면 막다른 골목이다. 다른 도구를 찾으라는 신호가 있어야 우회로로 간다.
  {
    const src = readFileSync(
      new URL("../../core/llm-runtime/capabilities/file-ops-mcp.ts", import.meta.url),
      "utf8",
    );
    const i = src.indexOf("if (looksBinary(headBuf))");
    const body = i < 0 ? "" : src.slice(i, i + 700);
    out.push({
      name: "★응답이 다른 도구를 찾으라고 알린다(막다른 골목이 아님)",
      ok: body.includes("Bash") && body.includes("텍스트가 아닙니다"),
      got: `안내=${body.includes("Bash")} 사실고지=${body.includes("텍스트가 아닙니다")}`,
    });
    out.push({
      name: "진단 수치(경로·크기)를 같이 준다",
      ok: body.includes("path=${abs}") && body.includes("humanBytes(stat.size)"),
      got: `path=${body.includes("path=${abs}")} size=${body.includes("humanBytes(stat.size)")}`,
    });
  }

  return out;
};

export const check: RegressionCheck = {
  name: "read-binary-honesty",
  guards:
    "텍스트 아닌 파일(APK·실행파일·zip…)을 깨진 UTF-8 로 **성공** 반환해 비서가 헛다리를 짚던 것 — 2026-08-01 이미지 사고에서 이미지만 고치고 남겨둔 구멍",
  run,
};
