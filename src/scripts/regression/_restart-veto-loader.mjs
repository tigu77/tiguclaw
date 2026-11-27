// 자식 프로브 전용. tsx 가 해석한 이 파일 하나의 종료 판정만 false 로 고정한다.
import { readFileSync } from "node:fs";
import ts from "typescript";

const restart = new URL("../../core/restart.ts", import.meta.url).href;
const original = "hasSupervisorRespawnOn(input.platform) ? true : input.respawnArranged";

export async function load(url, context, nextLoad) {
  if (url !== restart) return nextLoad(url, context);
  const source = readFileSync(new URL(url), "utf8");
  if (source.split(original).length !== 2) throw new Error("restart veto fixture: guard drift");
  const { outputText } = ts.transpileModule(source.replace(original, "false"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  console.log("[fixture] restart veto installed");
  return { format: "module", source: outputText, shortCircuit: true };
}
