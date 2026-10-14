/**
 * 회귀: **기본 꺼짐 번들(`tiguclaw.defaultOff`)은 아무도 안 켜면 안 돌고, 켜면 돈다** (2026-10-14 — 자가성장 은퇴).
 *
 * 정태님: *«윈도우돌쇠랑 돌쇠에서 자가성장 끈 거 문제없으면 기본으로 끄는 게 맞지»*. 교정은 코어가 맡았고(`confirm_feedback`·
 * `feedback-capture`), 자가성장 자동 학습은 두 인스턴스에서 끈 뒤 문제가 없었다(돌쇠 10-13~ · 윈도우 10-14~).
 * ★«없으면 켜짐» 규칙의 예외는 **선언으로만** 생긴다 — 이름 목록을 코드에 두지 않는다. 그래서 이 검사는 실제 번들
 *  매니페스트(`plugins/self-growth/package.json`)를 대상으로, 판정 함수 하나(`isModuleActive`)와 로더의 스킵 사유를 본다.
 * ★반대 방향도 본다: 선언 없는 번들(scheduler)은 여전히 켜져 있다(기본 꺼짐이 새지 않는다).
 *
 * 등급: **실행** — 러너가 잡은 임시 홈의 settings.json 을 실제로 쓰고 판정 함수를 부른다.
 */
import { assert, type Assertion, type RegressionCheck } from "./_framework.js";

export const check: RegressionCheck = {
  name: "plugin-default-off",
  guards:
    "은퇴한 자가성장이 새 설치·업데이트에서 기본으로 켜진 채 나가던 것 + 기본 꺼짐 번들을 사용자가 켜도 안 켜지거나, 끈 것이 기본값에 덮이거나, 기본 꺼짐이 다른 번들로 새는 것",
  run: async (): Promise<Assertion[]> => {
    const out: Assertion[] = [];
    const { setModuleDisabled } = await import("../../core/settings.js");
    const { isModuleActive, isDefaultOffModule } = await import("../../core/plugins/inventory.js");
    const { refusalToRun } = await import("../../core/plugins/loader.js");
    const { appRoot } = await import("../../core/paths.js");
    const { getPaths } = await import("../../core/paths.js");
    const { readFileSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
    const path = await import("node:path");
    const bundledRoot = path.join(appRoot(), "plugins");
    const file = getPaths().settings;
    const saved = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    try {
      // 설정에 아무 말이 없을 때 — 자가성장은 꺼져 있고, 사유는 «기본 꺼짐» 이다.
      if (existsSync(file)) rmSync(file);
      const declared = isDefaultOffModule("self-growth");
      const offByDefault = !isModuleActive("self-growth");
      const reason = refusalToRun(bundledRoot, "self-growth");
      const schedulerOn = isModuleActive("scheduler") && !isDefaultOffModule("scheduler");
      out.push(
        assert(
          "★★설정이 비어 있으면 자가성장은 **꺼져 있다**(매니페스트 `defaultOff`) · 로그 사유는 «default-off»(사용자가 끈 것과 구분)",
          declared && offByDefault && reason === "default-off",
          `선언=${String(declared)} · 꺼짐=${String(offByDefault)} · 사유=${String(reason)}`,
        ),
      );
      out.push(
        assert(
          "기본 꺼짐이 새지 않는다 — 선언 없는 번들(scheduler)은 그대로 켜져 있다",
          schedulerOn,
          `scheduler 켜짐=${String(schedulerOn)}`,
        ),
      );
      // 사용자가 켜면 켜진다(명시 enabled:true 가 선언을 이긴다).
      setModuleDisabled("self-growth", false);
      const onWhenEnabled = isModuleActive("self-growth") && refusalToRun(bundledRoot, "self-growth") === undefined;
      // 다시 끄면 «사용자가 끈 것» 으로 꺼진다.
      setModuleDisabled("self-growth", true);
      const offWhenDisabled = !isModuleActive("self-growth") && refusalToRun(bundledRoot, "self-growth") === "user-disabled";
      out.push(
        assert(
          "★사용자가 켜면 켜지고(명시 `enabled: true` 가 기본 꺼짐을 이긴다), 끄면 «사용자가 끈 것» 으로 꺼진다",
          onWhenEnabled && offWhenDisabled,
          `켬→${String(onWhenEnabled)} · 끔→${String(offWhenDisabled)}`,
        ),
      );
      // 옛 배열 모양(`disabled: [...]`)과 섞여도 끈 것이 이긴다(AND 규칙 유지).
      writeFileSync(file, JSON.stringify({ modules: { disabled: ["self-growth"], "self-growth": { enabled: true } } }));
      const andRule = !isModuleActive("self-growth");
      out.push(
        assert(
          "어느 층이든 끈 기록이 있으면 꺼진다 — 명시 켜기가 옛 끄기 목록을 되살리지 않는다(AND 규칙)",
          andRule,
          `옛 목록 꺼짐 + 새 모양 켜짐 → 활성=${String(!andRule)}`,
        ),
      );
    } finally {
      if (saved === undefined) { if (existsSync(file)) rmSync(file); } else writeFileSync(file, saved);
    }
    return out;
  },
};
