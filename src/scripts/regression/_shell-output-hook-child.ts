/**
 * `shell-output-encoding` 의 훅 자식 — 격리 홈(`getPaths()` 가 홈을 동결하므로 자식으로 띄운다)에서 PreToolUse 훅이 **CP949 바이트**로 차단 사유를
 *  쓰게 하고, Windows 판정(OEM `euc-kr`)을 주입한 채 진짜 `runPreToolUseHooks` 로 돌린다. 출력: 마지막 줄 JSON `{ block, reason }`.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { nodeCommand } from "./_shell-fixture.js";

const home = process.env.TIGUCLAW_HOME ?? "";
const hex = process.env.REASON_HEX ?? "";
// REAL_CMD 가 있으면 그 cmd 명령을 그대로 훅으로 쓰고 디코더도 진짜(Windows 전용 검사) — 없으면 CP949 바이트를 쓰는 node 훅 + Windows 판정 주입.
const realCmd = process.env.REAL_CMD;
if (realCmd === undefined) {
  const { __forceShellDecoderForTest } = await import("../../core/shell-output-decoder.js");
  __forceShellDecoderForTest({ platform: "win32", oemLabel: "euc-kr" });
}
writeFileSync(
  path.join(home, "settings.json"),
  JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "^Danger$",
          hooks: [{ type: "command", command: realCmd ?? nodeCommand(`process.stderr.write(Buffer.from(${JSON.stringify(hex)},"hex"));process.exitCode=2;`) }],
        },
      ],
      // stdout(줄바꿈 없음, exit 0) → additionalContext — `done()` 안의 stdout 확정이 지켜진다(GPT R1)
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: process.env.REAL_CTX_CMD ?? nodeCommand(`process.stdout.write(Buffer.from(${JSON.stringify(process.env.CTX_HEX ?? "")},"hex"));`) }] },
      ],
    },
  }),
);
const H = await import("../../core/entry/hook-runner.js");
const r = await H.runPreToolUseHooks({ toolName: "Danger", toolInput: {}, cwd: home, channel: "regr", threadKey: "regr:hook-enc" });
const u = await H.runUserPromptSubmitHooks({ prompt: "x", cwd: home, channel: "regr", threadKey: "regr:hook-enc" });
console.log(JSON.stringify({ block: r.block, reason: r.blockReason ?? "", context: (u as { additionalContext?: string }).additionalContext ?? "" }));
