/**
 * 회귀: **메모리 인덱스 캡은 설정으로 조절된다 — 그리고 이상값에 안 무너진다**
 * (2026-09-02 정태님: *"옵션에 크기 조절 옵션을 넣고 줄일 수도 있고 늘릴 수도 있는거지"*).
 *
 * ★배경: 인덱스가 매 턴 상수의 **33.5%**(33.3KB / 99.3KB)로 가장 큰 조각이고, 실측으로
 *  3주에 8.1 → 31.9KB(+294%) 자랐다. 설치마다 메모리 양도 예산도 다른데 값이 **코드 상수**
 *  라 사용자가 손댈 수 없었다.
 *
 * ★**기본값은 안 내렸다.** «반으로» 를 재봤더니 20,480B 에서 사람이 쓴 77건이 잘리고 그
 *  안에 상시 행동 규칙이 있었다(`style-never-auto-push-…` access 17 등). 경계도 촘촘하다 —
 *  잘리는 것 최대 access 19 / 남는 것 최소 20. 이 레포는 같은 기제로 두 번 데였다.
 *  **값을 정하는 건 사용자, 기본을 정하는 건 실측이다.**
 *
 * ★이상값을 **무시하고 기본값**으로 가는 게 핵심이다 — 설정 오타 하나로 비서가 자기 기억을
 *  통째로 잃으면(`0` 이면 인덱스가 사라진다) 그건 «조절» 이 아니라 사고다(도달 축 ⑩).
 *
 * 등급: **동작**(리더를 실제 파일로 돌린다).
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMemoryIndexCapBytes } from "../../core/settings.js";
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

const DEFAULT = 40_960;

/** 임시 cwd 에 프로젝트 설정을 두고 리더를 돌린다. */
const withSettings = (value: unknown): number => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tgc-memcap-"));
  try {
    mkdirSync(path.join(dir, ".tiguclaw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".tiguclaw", "settings.json"),
      JSON.stringify({ memory: { indexCapBytes: value } }),
      "utf8",
    );
    return readMemoryIndexCapBytes(DEFAULT, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const check: RegressionCheck = {
  name: "memory-index-cap-configurable",
  guards:
    "매 턴 상수의 33.5% 를 차지하는 메모리 인덱스 캡이 코드 상수라 설치마다 조절할 수 없던 것 + 그 값을 열면서 이상값(0·음수·거대값)이 비서의 기억을 통째로 없애거나 무한 증가시키는 것(2026-09-02)",
  run: async (): Promise<Assertion[]> => {
    const ok20 = withSettings(20_480);
    const ok80 = withSettings(81_920);
    return [
      assert(
        "★★줄일 수 있다 — 설정값이 실제로 쓰인다(0이면 아래 거절들은 공짜 초록이다)",
        ok20 === 20_480,
        `${String(ok20)}B`,
      ),
      assert(
        "★늘릴 수도 있다 — 조절은 양방향이다",
        ok80 === 81_920,
        `${String(ok80)}B`,
      ),
      assert(
        "★★`0`·음수는 **무시하고 기본값** — 오타 하나로 비서가 자기 기억을 통째로 잃으면 조절이 아니라 사고다",
        withSettings(0) === DEFAULT && withSettings(-1) === DEFAULT,
        `0→${String(withSettings(0))} · -1→${String(withSettings(-1))}`,
      ),
      assert(
        "★너무 작은 값도 막는다(4KB 미만) — 인덱스가 남아도 몇 줄뿐이면 «있다» 가 거짓이 된다",
        withSettings(1_024) === DEFAULT,
        `1024→${String(withSettings(1_024))}`,
      ),
      assert(
        "★상한도 있다(512KB) — 없으면 설정 하나로 매 턴 프롬프트가 무한 증가한다",
        withSettings(10_000_000) === DEFAULT,
        `10MB→${String(withSettings(10_000_000))}`,
      ),
      assert(
        "★숫자가 아니면 무시한다(문자열·null·객체)",
        withSettings("20480") === DEFAULT &&
          withSettings(null) === DEFAULT &&
          withSettings({}) === DEFAULT,
        `"20480"→${String(withSettings("20480"))} · null→${String(withSettings(null))}`,
      ),
      assert(
        "★설정이 아예 없으면 기본값(회귀 0)",
        readMemoryIndexCapBytes(DEFAULT, os.tmpdir()) === DEFAULT,
        `${String(readMemoryIndexCapBytes(DEFAULT, os.tmpdir()))}B`,
      ),
    ];
  },
};
