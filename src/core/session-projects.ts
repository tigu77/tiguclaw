/**
 * 세션에 연결한 프로젝트 — **판단은 여기 한 곳**(2026-10-08, docs/decisions/2026-10-08-session-project-links.md).
 *
 * «이 세션에 무엇이 연결돼 있나 · 어떤 커맨드가 보이나 · 이 이름은 어느 커맨드인가 · 비서 맥락에 무엇을 싣나» 를 정한다.
 * 대시보드·텔레그램(`/project`)·브리지·비서 도구는 결과를 그리거나 부르기만 한다(가장자리는 판단하지 않는다).
 *
 * ★연결은 **등록된 프로젝트만**(= `PROJECT.md` 가 있는 등록 폴더) — «연결해서 쓸 정도면 프로젝트» (정태님). 일반 폴더는 먼저 등록.
 * ★연결된 프로젝트의 커맨드는 그 프로젝트의 `.tiguclaw/commands` 에서만 찾는다(`discoverProjectCommands`).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { listProjects, type ProjectRow } from "../store/projects.js";
import { deleteSessionProject, insertSessionProject, listSessionProjectPaths } from "../store/session-projects.js";
import { discoverProjectCommands, expandCommandFile, resolveCommand, splitFirstToken, type Command } from "./entry/command-registry.js";
import { getEventBus } from "./eventbus.js";
import { isDerivedThread } from "./threadkey.js";

/** 연결이 바뀌었다 — 어디서 바꿨든(비서 도구·`/project`·대시보드) 그 세션을 보는 화면이 다시 읽는다. */
const announce = (threadKey: string): void =>
  getEventBus().publish({ type: "session.projects.changed", ts: Date.now(), payload: { threadKey } });

export interface LinkedProject {
  path: string;
  name: string;
  description: string | null;
  /** 아직 레지스트리에 있는가(연결 뒤 등록 해제될 수 있다 — 연결은 남기고 이름만 폴더명으로). */
  registered: boolean;
  /** 폴더가 지금 있는가 — 없어도 자동 해제하지 않는다(외장 드라이브처럼 잠깐 안 보일 수 있다). */
  exists: boolean;
}

const norm = (p: string): string => path.resolve(p);

/** 이 세션에 연결된 프로젝트 — 연결한 순서대로. */
export const linkedProjects = (threadKey: string): LinkedProject[] => {
  const reg = new Map(listProjects().map((p) => [norm(p.path), p] as const));
  return listSessionProjectPaths(threadKey).map((p) => {
    const r = reg.get(norm(p));
    return {
      path: p,
      name: r?.name ?? path.basename(p),
      description: r?.description ?? null,
      registered: r !== undefined,
      exists: existsSync(p),
    };
  });
};

/** 등록된 프로젝트를 이름(대소문자 무시)이나 경로로 찾는다. 이름이 겹치면 후보만 돌려준다(아무거나 고르지 않는다). */
export const findRegisteredProject = (ref: string): { project?: ProjectRow; candidates: ProjectRow[] } => {
  const all = listProjects();
  const want = ref.trim();
  const byPath = all.find((p) => norm(p.path) === norm(want));
  if (byPath !== undefined) return { project: byPath, candidates: [byPath] };
  const byName = all.filter((p) => p.name.toLowerCase() === want.toLowerCase());
  return byName.length === 1 ? { project: byName[0], candidates: byName } : { candidates: byName };
};

export type LinkResult =
  | { ok: true; project: ProjectRow; already: boolean }
  | { ok: false; reason: "not-registered" | "ambiguous" | "name-taken" | "not-a-conversation"; candidates: ProjectRow[] };

/**
 * 연결 — 등록된 프로젝트만. 이미 연결돼 있으면 그대로(already).
 *  ★사람이 말을 건 대화에만 — 매니저·스케줄 같은 파생 턴(`worker:`·`scheduler:` …)에서 부르면 그 내부 좌표에 걸려
 *   사용자 화면엔 아무것도 안 생기는데 «연결했다» 고 보고하게 된다(2026-10-08 적대 검토).
 *  ★한 대화 안에서 **이름은 하나**다 — 메뉴·버튼·`/project run <이름>` 이 이름으로 가리키므로, 같은 이름 둘이면
 *   둘째를 골라도 첫째가 돈다(같은 검토, P1). 경로가 다른 동명 프로젝트는 연결을 거절하고 이름을 바꾸게 한다.
 */
export const linkProject = (threadKey: string, ref: string): LinkResult => {
  if (isDerivedThread(threadKey)) return { ok: false, reason: "not-a-conversation", candidates: [] };
  const found = findRegisteredProject(ref);
  if (found.project === undefined) {
    return { ok: false, reason: found.candidates.length > 1 ? "ambiguous" : "not-registered", candidates: found.candidates };
  }
  const want = norm(found.project.path);
  const name = found.project.name.toLowerCase();
  if (linkedProjects(threadKey).some((p) => norm(p.path) !== want && p.name.toLowerCase() === name)) {
    return { ok: false, reason: "name-taken", candidates: [found.project] };
  }
  const added = insertSessionProject(threadKey, want);
  if (added) announce(threadKey);
  return { ok: true, project: found.project, already: !added };
};

/** 연결된 것 중에서 이름(대소문자 무시)이나 경로로 찾는다 — 등록이 풀린 연결도 찾는다. */
export const findLinkedProject = (threadKey: string, ref: string): LinkedProject | undefined => {
  const want = ref.trim();
  const linked = linkedProjects(threadKey);
  return (
    linked.find((p) => norm(p.path) === norm(want)) ??
    linked.find((p) => p.name.toLowerCase() === want.toLowerCase())
  );
};

/** 해제 — 연결돼 있던 것만. */
export const unlinkProject = (threadKey: string, ref: string): { ok: true; project: LinkedProject } | { ok: false } => {
  const p = findLinkedProject(threadKey, ref);
  if (p === undefined) return { ok: false };
  deleteSessionProject(threadKey, p.path);
  announce(threadKey);
  return { ok: true, project: p };
};

/** 연결된 프로젝트마다 그 프로젝트의 커맨드. 폴더가 없으면 빈 목록. */
export const sessionProjectCommands = async (
  threadKey: string,
): Promise<{ project: LinkedProject; commands: Command[] }[]> =>
  Promise.all(
    linkedProjects(threadKey).map(async (project) => ({
      project,
      commands: project.exists ? await discoverProjectCommands(project.path) : [],
    })),
  );

export type SessionCommandMatch =
  | { kind: "none" }
  | { kind: "one"; project: LinkedProject; command: Command }
  | { kind: "ambiguous"; matches: { project: LinkedProject; command: Command }[] };

/** 이 세션에서 이 이름의 프로젝트 커맨드 — 연결된 프로젝트들에서. 둘 이상이면 고르게 한다. */
export const findSessionCommand = async (threadKey: string, name: string): Promise<SessionCommandMatch> => {
  const matches = (await sessionProjectCommands(threadKey)).flatMap(({ project, commands }) =>
    commands.filter((c) => c.name === name).map((command) => ({ project, command })),
  );
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", project: matches[0]!.project, command: matches[0]!.command };
  return { kind: "ambiguous", matches };
};

/** 프로젝트 이름을 슬래시 명령 인자로 — 공백이 있으면 따옴표. */
export const quoteProject = (name: string): string => (/\s/.test(name) ? `"${name}"` : name);

export type SessionExpand =
  | { kind: "text"; text: string }
  | { kind: "choose"; options: { label: string; value: string }[] }
  | { kind: "missing"; project: string; command: string }
  /** 실행형 — 비서 턴 없이 `script` 를 `project.path` 에서 돌린다. */
  | { kind: "run"; project: LinkedProject; command: string; script: string }
  /** 실행형인데 `confirm: true` — 돌리기 전에 묻는다. `value` 를 다시 보내면 실행한다. */
  | { kind: "confirm"; project: LinkedProject; command: string; script: string; value: string }
  /** 전역 커맨드에 `run:` — 어느 폴더에서 돌지 정할 근거가 없어 돌리지 않는다(연결한 프로젝트의 커맨드에서만). */
  | { kind: "run-needs-project"; command: string }
  | { kind: "none" };

/**
 * `/project run` 의 확인 표식 — `--yes=<지문>`. 확인 버튼이 이 꼴을 보낸다.
 * ★지문은 **확인창에 보여 준 그 한 줄**의 것이다 (2026-10-08 적대 검토). 이름만 실으면 확인창이 뜬 뒤 파일이 바뀌어도
 *  (비서의 덮어쓰기·git pull) 사용자가 본 적 없는 줄이 묻지 않고 돌았다. 지문이 다르거나 없으면(`--yes` 만) 다시 묻는다.
 */
export const RUN_CONFIRMED = "--yes";
export const scriptPrint = (script: string): string => createHash("sha256").update(script).digest("hex").slice(0, 12);

/** 프로젝트 커맨드 하나를 펼친다 — 실행형이면 실행·확인, 아니면 비서에게 보낼 글. */
const expandProjectCommand = async (
  project: LinkedProject,
  command: Command,
  args: string,
  confirmedPrint?: string,
): Promise<SessionExpand | undefined> => {
  if (command.run === undefined) {
    const text = await expandCommandFile(command, args);
    return text === undefined ? undefined : { kind: "text", text };
  }
  const script = command.run.replaceAll("$ARGUMENTS", args.trim()).trim();
  if (command.confirm && confirmedPrint !== scriptPrint(script)) {
    const rest = args.trim() === "" ? "" : ` ${args.trim()}`;
    return {
      kind: "confirm",
      project,
      command: command.name,
      script,
      value: `/project run ${RUN_CONFIRMED}=${scriptPrint(script)} ${quoteProject(project.name)} ${command.name}${rest}`,
    };
  }
  return { kind: "run", project, command: command.name, script };
};

/**
 * 슬래시 이름을 이 세션 기준으로 펼친다 — 채널 입구(`index.ts`)가 부르는 한 곳.
 *  ① `/project run <프로젝트> <커맨드> [인자]` — 그 프로젝트의 그 커맨드(메뉴·버튼·겹치는 이름이 이 꼴을 보낸다)
 *  ② 전역 커맨드(`expandCommand` — 홈·플러그인·데몬 폴더)가 먼저 — 종전 동작 그대로
 *  ③ 없으면 연결된 프로젝트에서: 하나 → 그것 · 여럿 → 고르게(추측해서 아무거나 실행하지 않는다)
 *  ★②가 ③보다 먼저인 이유(2026-10-08 적대 검토): 반대면 연결한 남의 레포의 `review.md` 가 사용자의 `/review` 를
 *   조용히 가로채고, 그 세션에선 전역 커맨드를 부를 길이 없어진다. 겹치는 프로젝트 커맨드는 ①로 부른다
 *   (대시보드 `/` 목록·📁 메뉴가 그 꼴을 넣는다).
 */
export const expandSessionCommand = async (threadKey: string, name: string, args: string): Promise<SessionExpand> => {
  if (name === "project") {
    const sub = splitFirstToken(args);
    if (sub.first !== "run") return { kind: "none" };
    let rest = sub.rest;
    const yes = splitFirstToken(rest);
    const confirmed = yes.first === RUN_CONFIRMED || yes.first.startsWith(`${RUN_CONFIRMED}=`);
    if (confirmed) rest = yes.rest;
    const confirmedPrint = confirmed ? yes.first.slice(RUN_CONFIRMED.length + 1) : undefined;
    const proj = splitFirstToken(rest);
    const cmd = splitFirstToken(proj.rest);
    const project = findLinkedProject(threadKey, proj.first);
    const command = project?.exists === true ? (await discoverProjectCommands(project.path)).find((c) => c.name === cmd.first) : undefined;
    const out = project !== undefined && command !== undefined ? await expandProjectCommand(project, command, cmd.rest, confirmedPrint) : undefined;
    return out ?? { kind: "missing", project: proj.first, command: cmd.first };
  }
  const global = await resolveCommand(name);
  if (global !== undefined && global.run === undefined) {
    const text = await expandCommandFile(global, args);
    if (text !== undefined) return { kind: "text", text };
  }
  // 전역의 실행형은 건너뛰고 연결 프로젝트에서 찾는다 — 데몬이 떠 있는 폴더가 곧 연결한 프로젝트면(개발 인스턴스가
  // 자기 레포를 연결) 같은 파일이 «전역» 으로도 잡히는데, 그걸 거절하면 `/deploy` 가 막혔다(적대 검토).
  const m = await findSessionCommand(threadKey, name);
  if (m.kind === "one") {
    const out = await expandProjectCommand(m.project, m.command, args);
    if (out !== undefined) return out;
  }
  if (m.kind === "ambiguous") {
    return {
      kind: "choose",
      options: m.matches.map(({ project }) => ({
        label: `${project.name} · /${name}`,
        value: `/project run ${quoteProject(project.name)} ${name}${args.trim() === "" ? "" : ` ${args.trim()}`}`,
      })),
    };
  }
  if (global?.run !== undefined) return { kind: "run-needs-project", command: name };
  return { kind: "none" };
};

/**
 * 비서 맥락 — 연결된 프로젝트마다 한 줄(이름·경로·한 줄 설명). `PROJECT.md` 전문은 싣지 않는다(필요하면 비서가 읽는다 — 매 턴
 * 필요한 것만 상시로). 연결이 없으면 빈 배열.
 * ★프로젝트 전용 스킬·에이전트·MCP 는 메인 대화에 섞지 않는다(3단계, 2026-10-08) — 그것들은 «작업 폴더 = 그 프로젝트» 를
 *  전제로 쓰였다(상대 경로·그 폴더 에이전트). 위임할 때 `path` 로 그 폴더를 주면 그 폴더 기준으로 전부 켜진다 — 그 길을 알린다.
 * @param inherited 매니저·서브에이전트의 맥락 — 자기 대화가 아니라 **이 일을 맡긴 대화**의 연결이다.
 */
export const linkedProjectsContextLines = (threadKey: string, opts: { inherited?: boolean } = {}): string[] => {
  const linked = linkedProjects(threadKey);
  if (linked.length === 0) return [];
  const head = opts.inherited === true ? "이 일을 맡긴 대화에 연결된 프로젝트(그 대화가 다루는 일이다" : "이 대화에 연결된 프로젝트(대화 내내 유지 · 이 대화는 이 프로젝트들의 일이다";
  return [
    `- ${head} · 자세한 건 각 폴더의 PROJECT.md · 그 프로젝트 전용 스킬·에이전트·MCP 는 위임할 때 path 로 그 폴더를 주면 켜진다 — 목록은 project_capabilities):`,
    ...linked.map((p) => {
      const desc = p.description !== null && p.description.trim() !== "" ? ` — ${p.description.trim()}` : "";
      return `  - ${p.name}: ${p.path}${desc}${p.exists ? "" : " (★폴더가 지금 없다)"}`;
    }),
  ];
};

/** `PROJECT.md` 를 보여 줄 때 — 앞부분만(채널 메시지 한도). 없으면 undefined. */
export const projectMdHead = (projectPath: string, maxChars = 3_000): string | undefined => {
  try {
    const raw = readFileSync(path.join(projectPath, "PROJECT.md"), "utf8");
    return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…` : raw;
  } catch {
    return undefined;
  }
};
