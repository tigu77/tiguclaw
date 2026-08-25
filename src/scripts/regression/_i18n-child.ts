/**
 * `i18n-user-extensible` 의 자식 프로세스 — 격리된 홈에서 카탈로그를 읽는다.
 * ★자식인 이유: `getPaths()` 가 첫 호출에 홈을 얼린다. 같은 프로세스에서 홈을 바꿔가며
 *  재보려 하면 두 번째부터 조용히 첫 홈을 본다(그러면 검사가 항상 초록이다).
 */
import {
  availableLocales,
  catalogForClient,
  readLocale,
  translate,
} from "../../core/i18n.js";

const home = process.env.TIGUCLAW_HOME ?? "";
// `--set-locale <lang>` 이면 쓰기 경로를 태운다(캐시 무효화 포함).
let setLocaleOk: boolean | undefined;
const at = process.argv.indexOf("--set-locale");
let afterSetInSameProcess: string | undefined;
let afterFileEdit: string | undefined;
if (at >= 0) {
  // ★바꾸기 **전에 한 번 읽어** 카탈로그를 캐시에 올린다 — 그래야 `clearCatalogCache` 가
  //  빠졌을 때 옛 값이 남는 게 드러난다. 매번 새 프로세스로만 재면 캐시가 애초에 비어 있어
  //  그 변이가 그대로 통과한다(실제로 통과했다).
  translate("chat.send");
  const { setLocale } = await import("../../core/settings.js");
  setLocaleOk = setLocale(process.argv[at + 1] ?? "");
  afterSetInSameProcess = translate("chat.send");
}
// `--edit-catalog <lang> <값>` — **같은 프로세스에서** 파일을 고치고 다시 읽는다.
//  캐시가 파일 시각으로 안 무효화되면 옛 값이 남는다("고쳤는데 그대로").
const editAt = process.argv.indexOf("--edit-catalog");
if (editAt >= 0) {
  const lang = process.argv[editAt + 1] ?? "";
  const value = process.argv[editAt + 2] ?? "";
  translate("chat.send"); // 먼저 읽어 캐시에 올린다
  const { writeFileSync } = await import("node:fs");
  const nodePath = await import("node:path");
  writeFileSync(
    nodePath.join(home, "locales", `${lang}.json`),
    JSON.stringify({ "chat.send": value }) + "\n",
    "utf8",
  );
  afterFileEdit = translate("chat.send");
}
process.stdout.write(
  JSON.stringify({
    home,
    locale: readLocale(),
    locales: availableLocales(),
    send: translate("chat.send"),
    settingsLabel: translate("nav.settings"),
    missing: translate("nope.missing.key"),
    interpolated: translate("compact.running", { turns: 12 }),
    // ★값을 **주되 필요한 키가 없는** 경우 — params 가 undefined 면 보간 자체를 안 지나서
    //  "누락 값을 빈칸으로" 변이가 그대로 통과한다(실제로 통과했다).
    missingParam: translate("compact.running", { other: 1 }),
    catalogSize: Object.keys(catalogForClient().strings).length,
    ...(setLocaleOk !== undefined ? { setLocaleOk } : {}),
    ...(afterSetInSameProcess !== undefined ? { afterSetInSameProcess } : {}),
    ...(afterFileEdit !== undefined ? { afterFileEdit } : {}),
  }) + "\n",
);
