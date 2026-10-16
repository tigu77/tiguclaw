/**
 * **플러그인 폴더 중 지금 켜진 것** — 스킬·에이전트·커맨드·엔드포인트 레지스트리가 플러그인 자산을 훑는 한 곳 (2026-10-16).
 *
 * ★종전엔 같은 «폴더 훑기» 가 레지스트리마다 복사돼 있었고(네 벌), 어느 것도 켜짐을 안 봤다 — 꺼 둔 플러그인의 스킬·에이전트·
 *  커맨드가 비서의 목록에 그대로 남아 «없는 능력» 을 안내했다(텔레그램 연결 스킬을 플러그인에 넣으며 확인). 판정은 로더와 같은
 *  `isModuleActive`(코어는 늘 켜짐 · 사용자 끔 · 기본 꺼짐 번들)다.
 * ★이름은 **매니페스트의 `name`** 으로 판정한다 — 직접 설치한 플러그인은 폴더 이름이 달라도 된다(끄기·켜기는 매니페스트 이름 기준).
 *  돌려주는 `id` 는 종전처럼 폴더 이름이다(출처 표시·중복 판정이 그 값을 쓴다).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const manifestName = async (dir: string, fallback: string): Promise<string> => {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { tiguclaw?: { name?: unknown } };
    return typeof pkg.tiguclaw?.name === "string" && pkg.tiguclaw.name !== "" ? pkg.tiguclaw.name : fallback;
  } catch {
    return fallback;
  }
};

/** 부재 디렉터리는 빈 배열. 정렬은 폴더 이름순(종전과 같음). */
export const activePluginDirs = async (pluginsRoot: string): Promise<Array<{ id: string; dir: string }>> => {
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  // 인벤토리가 레지스트리들을 import 하므로 판정은 동적으로 가져온다(순환 import 방지).
  const { moduleActivityJudge } = await import("./inventory.js");
  const isModuleActive = moduleActivityJudge(); // 매니페스트·끔 목록을 한 번만 읽는다
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
    .map((e) => ({ id: e.name, dir: path.join(pluginsRoot, e.name) }));
  const active = await Promise.all(dirs.map(async (d) => isModuleActive(await manifestName(d.dir, d.id))));
  return dirs.filter((_, i) => active[i]).sort((a, b) => a.id.localeCompare(b.id));
};
