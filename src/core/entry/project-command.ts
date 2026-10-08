/**
 * `/project` — 이 대화(세션)에 연결한 프로젝트의 목록·연결·메뉴·해제 (2026-10-08, docs/decisions/2026-10-08-session-project-links.md).
 *
 * 텔레그램처럼 칩이 없는 채널의 입구다(대시보드는 📁 칩이 같은 일을 한다). 판단은 `core/session-projects.ts` — 여기는 그 결과를
 * 선택지로 그리기만 한다. 선택지의 값은 다시 들어오는 슬래시 명령이다(`/sessions` 와 같은 흐름).
 *  `/project`                       연결된 프로젝트(+ 연결 버튼)
 *  `/project link [이름]`            연결할 프로젝트 고르기 / 연결
 *  `/project open <이름>`            그 프로젝트 메뉴 — 커맨드 · PROJECT.md · 연결 해제
 *  `/project show <이름>`            PROJECT.md 앞부분
 *  `/project unlink <이름> [confirm]` 해제 확인 / 해제
 *  `/project run [--yes] <이름> <커맨드> [인자]` → 아래 `dispatchCommandSlash` — 프롬프트형은 비서 턴, 실행형은 셸
 */
import { listProjects } from "../../store/projects.js";
import { translate } from "../i18n.js";
import { getAssistantName } from "../identity.js";
import { redactSecrets } from "../outbound-sanitize.js";
import { killShellById, startBackgroundShell, type BgShellResult } from "../llm-runtime/capabilities/file-ops-mcp.js";
import {
  expandSessionCommand,
  findLinkedProject,
  linkedProjects,
  linkProject,
  projectMdHead,
  quoteProject,
  unlinkProject,
  type LinkedProject,
} from "../session-projects.js";
import { discoverProjectCommands, isEphemeralCommandText, splitFirstToken } from "./command-registry.js";
import { presentAndClose, replyCommand } from "./reply-command.js";
import type { SlashCtx } from "./slash-commands.js";

/** 인자 전체를 프로젝트 이름으로 — 따옴표를 벗긴다(공백 든 이름). */
const nameArg = (s: string): string => s.trim().replace(/^"([\s\S]*)"$/, "$1").trim();

type Option = { label: string; value: string };

/** 선택지를 띄운다 — 못 그리는 채널이면 텍스트로(선택지가 사라지지 않게). */
const offerOptions = async (
  msg: SlashCtx["msg"],
  question: string,
  options: Option[],
  opts: { note?: string; ephemeral: boolean },
): Promise<void> => {
  const r = await presentAndClose(msg, question, options, opts.note === undefined ? {} : { note: opts.note }, { ephemeral: opts.ephemeral });
  if (r.ok) return;
  await replyCommand(
    msg,
    [...(opts.note === undefined ? [] : [opts.note]), question, ...options.map((o) => `· ${o.label} — \`${o.value}\``)].join("\n"),
    { ephemeral: opts.ephemeral },
  );
};

export const handleProject = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed } = ctx;
  const ephemeral = isEphemeralCommandText(trimmed);
  const tk = msg.threadKey;
  const say = (text: string): Promise<void> => replyCommand(msg, text, { ephemeral });
  const offer = (question: string, options: Option[], note?: string): Promise<void> =>
    offerOptions(msg, question, options, { ...(note === undefined ? {} : { note }), ephemeral });
  const { first: sub, rest } = splitFirstToken(args);

  if (sub === "") {
    const linked = linkedProjects(tk);
    if (linked.length === 0) {
      await offerLink(tk, offer, say, translate("srv.project.none"));
      return;
    }
    await offer(translate("srv.project.pick"), [
      ...linked.map((p) => ({
        label: `📁 ${p.name}${p.exists ? "" : ` (${translate("srv.project.folderMissing")})`}`,
        value: `/project open ${quoteProject(p.name)}`,
      })),
      { label: translate("srv.project.linkButton"), value: "/project link" },
    ]);
    return;
  }

  if (sub === "link") {
    const name = nameArg(rest);
    if (name === "") {
      await offerLink(tk, offer, say);
      return;
    }
    const r = linkProject(tk, name);
    if (r.ok) {
      await say(translate(r.already ? "srv.project.alreadyLinked" : "srv.project.linked", { name: r.project.name }));
    } else {
      const key =
        r.reason === "ambiguous" ? "srv.project.ambiguous"
        : r.reason === "name-taken" ? "srv.project.nameTaken"
        : r.reason === "not-a-conversation" ? "srv.project.notConversation"
        : "srv.project.notRegistered";
      await say(translate(key, { name }));
    }
    return;
  }

  if (sub === "open" || sub === "show") {
    const name = nameArg(rest);
    const p = findLinkedProject(tk, name);
    if (p === undefined) {
      await say(translate("srv.project.notLinked", { name }));
      return;
    }
    if (sub === "show") {
      await say(`📁 ${p.name} — ${p.path}\n\n${projectMdHead(p.path) ?? translate("srv.project.noMd")}`);
      return;
    }
    const q = quoteProject(p.name);
    const commands = p.exists ? await discoverProjectCommands(p.path) : [];
    await offer(
      `📁 ${p.name}`,
      [
        ...commands.map((c) => ({
          label: `${c.run !== undefined ? "▶" : "💬"} /${c.name}${c.description !== "" ? ` — ${c.description}` : ""}`,
          value: `/project run ${q} ${c.name}`,
        })),
        { label: translate("srv.project.showMd"), value: `/project show ${q}` },
        { label: translate("srv.project.unlinkButton"), value: `/project unlink ${q}` },
      ],
      !p.exists ? translate("srv.project.folderMissing") : commands.length === 0 ? translate("srv.project.noCommands") : undefined,
    );
    return;
  }

  if (sub === "unlink") {
    const confirmed = /\sconfirm$/.test(` ${rest.trim()}`);
    const name = nameArg(confirmed ? rest.trim().replace(/\s*confirm$/, "") : rest);
    const p = findLinkedProject(tk, name);
    if (p === undefined) {
      await say(translate("srv.project.notLinked", { name }));
      return;
    }
    if (!confirmed) {
      // ★해제는 확인을 받는다(정태님) — 대시보드 칩 메뉴와 같은 규칙. «취소» 는 목록으로 돌아간다.
      await offer(translate("srv.project.unlinkConfirm", { name: p.name }), [
        { label: translate("srv.project.unlinkYes"), value: `/project unlink ${quoteProject(p.name)} confirm` },
        { label: translate("srv.project.cancel"), value: "/project" },
      ]);
      return;
    }
    unlinkProject(tk, p.path);
    await say(translate("srv.project.unlinked", { name: p.name }));
    return;
  }

  await say(translate("srv.project.usage"));
};

// ─── 내장 명령 뒤의 슬래시 — 채널 입구가 부르는 한 곳 ─────────────────────────────────

export type CommandSlashResult = { kind: "handled" } | { kind: "prompt"; text: string } | { kind: "none" };
const HANDLED: CommandSlashResult = { kind: "handled" };

/**
 * 내장 명령 뒤의 슬래시 — `/project …` 와 커맨드 파일(전역·이 대화에 연결한 프로젝트). 채널 입구(`index.ts`)는 결과만 쓴다:
 *  `handled` = 응답까지 끝 · `prompt` = 비서에게 보낼 글 · `none` = 원문 그대로 비서에게.
 * ★여기 둔 이유: `index.ts` 안에 있을 땐 import 만으로 데몬이 떠서, 고르기 뒤 return·«찾지 못함»·세션 키 같은 분기를
 *  동작으로 검사할 길이 없었다(2026-10-08 적대 검토 — 그 변이 넷이 전체 스위트를 통과했다).
 */
export const dispatchCommandSlash = async (ctx: SlashCtx, cmd: string): Promise<CommandSlashResult> => {
  const { msg, args } = ctx;
  if (cmd === "/project" && splitFirstToken(args).first !== "run") {
    await handleProject(ctx);
    return HANDLED;
  }
  const name = cmd.slice(1);
  const e = await expandSessionCommand(msg.threadKey, name, args);
  switch (e.kind) {
    case "text":
      return { kind: "prompt", text: e.text };
    case "none":
      return { kind: "none" };
    case "choose":
      // 연결된 프로젝트 여럿에 같은 이름 — 추측해서 아무거나 실행하지 않는다.
      await offerOptions(msg, translate("srv.project.chooseCommand", { name }), e.options, { ephemeral: false });
      return HANDLED;
    case "missing":
      await replyCommand(msg, translate("srv.project.missingCommand", { project: e.project, command: e.command }));
      return HANDLED;
    case "run-needs-project":
      await replyCommand(msg, translate("srv.project.runNeedsProject", { command: e.command }));
      return HANDLED;
    case "confirm":
      await offerOptions(
        msg,
        translate("srv.project.runConfirm", { command: e.command, project: e.project.name, script: e.script }),
        [
          { label: translate("srv.project.runYes"), value: e.value },
          { label: translate("srv.project.cancel"), value: "/project" },
        ],
        { ephemeral: false },
      );
      return HANDLED;
    case "run":
      await startRun(msg, e.project, e.command, e.script);
      return HANDLED;
  }
};

// ─── 실행형 커맨드(`run:`) ─────────────────────────────────────────────────────────

/**
 * 돌고 있는 실행 — 셸 id → 띄운 대화·무엇(프로젝트 폴더 + 커맨드).
 *  ·`/stop` 이 **그 대화의 것만** 멈춘다.
 *  ·같은 프로젝트의 같은 커맨드가 돌고 있으면 또 띄우지 않는다 — 두 번 누르면 배포가 병렬로 두 번 돌았다(적대 검토).
 */
const RUNS = new Map<string, { threadKey: string; what: string }>();

/** 지금 돌고 있는 실행형 커맨드 — `/health` 가 보여 준다(배포 가드가 «함께 멈춘다» 고 경고한다). */
export const listProjectRuns = (): string[] => [...RUNS.values()].map((r) => `${r.threadKey}:${r.what.split("\0")[1] ?? ""}`);

/** 이 대화에서 돌고 있는 실행형 커맨드를 멈춘다 — `/stop` 이 부른다. 멈춘 개수. */
export const stopProjectRuns = async (threadKey: string): Promise<number> => {
  const ids = [...RUNS].filter(([, r]) => r.threadKey === threadKey).map(([id]) => id);
  for (const id of ids) await killShellById(id);
  return ids.length;
};

/** 결과에 싣는 출력 꼬리 — 채널 한 메시지에 들어갈 만큼(전문은 대시보드 셸 카드에 있다). */
const RUN_TAIL_CHARS = 1_500;

export const formatRunResult = (command: string, project: string, r: BgShellResult, ms: number): string => {
  const secs = String(Math.max(1, Math.round(ms / 1000)));
  const head =
    r.status === "killed"
      ? translate("srv.project.runStopped", { command, project })
      : r.exitCode === 0
        ? translate("srv.project.runDone", { command, project, secs })
        : translate("srv.project.runFailed", { command, project, code: String(r.exitCode), secs });
  // 출력에 코드 펜스가 있으면 우리 펜스가 깨진다 — 보이는 모양만 살짝 바꾼다. 시크릿처럼 보이는 값은 가린다(채널로 그대로 나간다).
  const tail = redactSecrets(r.recent.trim().slice(-RUN_TAIL_CHARS)).replaceAll("```", "ˋˋˋ");
  return tail === "" ? head : `${head}\n\`\`\`\n${tail}\n\`\`\``;
};

/**
 * 실행형 커맨드를 띄운다 — 비서 턴 없이, 그 프로젝트 폴더에서, Bash 의 백그라운드 셸로(셸 카드·중지·재시작 정리가 같다).
 * ★기다리지 않는다 — 이 대화의 큐를 붙잡으면 실행이 끝날 때까지 다른 메시지를 못 받는다. 끝나면 결과를 보낸다.
 */
const startRun = async (msg: SlashCtx["msg"], project: LinkedProject, command: string, script: string): Promise<void> => {
  const what = `${project.path}\0${command}`;
  if ([...RUNS.values()].some((r) => r.what === what)) {
    await replyCommand(msg, translate("srv.project.runAlready", { command, project: project.name }));
    return;
  }
  let started: Awaited<ReturnType<typeof startBackgroundShell>>;
  try {
    started = await startBackgroundShell(script, project.path, msg.threadKey);
  } catch (err) {
    await replyCommand(msg, translate("srv.project.runCouldNotStart", { command, error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  const t0 = Date.now();
  RUNS.set(started.shellId, { threadKey: msg.threadKey, what });
  await replyCommand(msg, translate("srv.project.runStarted", { command, project: project.name, script }));
  void started.done
    .then(async (r) => {
      RUNS.delete(started.shellId);
      await replyCommand(msg, formatRunResult(command, project.name, r, Date.now() - t0));
    })
    .catch(() => {
      /* 결과 전송 실패 — 셸 카드에 결과가 남는다 */
    });
};

/** 아직 연결 안 된 등록 프로젝트를 고르게 한다. */
const offerLink = async (
  tk: string,
  offer: (q: string, o: { label: string; value: string }[], note?: string) => Promise<void>,
  say: (t: string) => Promise<void>,
  note?: string,
): Promise<void> => {
  const linked = new Set(linkedProjects(tk).map((p) => p.path));
  const registered = listProjects();
  const available = registered.filter((p) => !linked.has(p.path));
  // ★버튼 값은 **경로**로 — 이름이 같은 등록 프로젝트가 둘이면 이름으로는 «여럿» 으로 거절된다(2026-10-08 적대 검토).
  //  `link` 는 나머지 전부를 한 인자로 받으므로 공백 든 경로도 그대로 된다.
  if (available.length === 0) {
    // 등록된 게 아예 없으면 등록하는 법까지 — 대시보드 «+ 프로젝트» 의 빈 안내와 같은 말(2026-10-08).
    const empty = registered.length === 0 ? translate("srv.project.noneRegistered", { name: getAssistantName() }) : translate("srv.project.noneToLink");
    await say([...(note === undefined ? [] : [note]), empty].join("\n"));
    return;
  }
  await offer(
    translate("srv.project.pickLink"),
    available.map((p) => ({ label: `📁 ${p.name}`, value: `/project link ${p.path}` })),
    note,
  );
};
