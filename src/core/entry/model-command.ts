/** /model 표시·선택은 기존 선택지 경로를 사용하며 LLM을 호출하지 않는다. */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "../../channels/types.js";
import { canonicalSessionChannel, getThreadName } from "../../store/sessions.js";
import { getChannelSessionBinding } from "../../store/channel-session.js";
import { applySessionModelProfile, listSessionModelProfiles, resolveSessionModelSelection } from "../session-model-selection.js";
import { describeBasePool, resolveSessionProfilePool, specLabel } from "../llm-runtime/index.js";
import type { ModelSpec } from "../llm-runtime/index.js";
import { translate as t } from "../i18n.js";
import { presentAndClose, replyCommand } from "./reply-command.js";

const PAGE_SIZE = 8;
const MENU_TTL = 15 * 60_000;
const MENU_CAP = 100;
type Menu = { owner: string; sessionId: string; binding: string | null; names: string[]; expires: number };
const menus = new Map<string, Menu>();
const clip = (s: string, n: number): string => {
  const one = s.replace(/[\r\n\t]/g, " ");
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const address = (msg: IncomingMessage): string => (msg.channelAddress ?? msg.session?.channelAddress ?? "").trim();
const owner = (msg: IncomingMessage): string => JSON.stringify([msg.channel, address(msg), msg.channelUserId]);
// resolveSessionId는 조회 실패를 기본값으로 내리므로 변경 직전에는 store를 직접 읽는다.
const binding = (msg: IncomingMessage): string | null => getChannelSessionBinding(msg.channel, address(msg));
const poolText = (pool: ModelSpec[]): string => clip(pool.map((s) => `${specLabel(s)}${s.reasoning === undefined ? "" : ` [${s.reasoning}]`}${s.speed === undefined ? "" : ` [${s.speed}]`}`).join(" → ") || t("srv.model.poolNone"), 650);

export const renderSessionModelStatus = (msg: IncomingMessage): string => {
  const state = resolveSessionModelSelection(canonicalSessionChannel(msg.threadKey, msg.channel), msg.threadKey);
  const base = describeBasePool();
  const name = getThreadName(msg.threadKey);
  const lines = [
    t("srv.model.menu.session", { id: clip(msg.threadKey, 180), name: clip(name ?? t("srv.model.menu.unnamed"), 100) }),
    t("srv.model.menu.saved", { profile: clip(state.profileName ?? t("srv.model.menu.inherit"), 130) }),
    t("srv.model.menu.raw", { spec: clip(state.raw ?? t("srv.model.menu.none"), 200) }),
    t("srv.model.menu.applied", { source: state.source === "raw" ? t("srv.model.menu.direct") : state.source === "profile" ? clip(state.appliedProfile!, 130) : t("srv.model.menu.global", { profile: clip(base.profile ?? base.profileUnresolved ?? "default", 130) }) }),
    t("srv.model.menu.pool", { pool: poolText(state.source === "default" ? base.specs : state.pool) }),
  ];
  if (state.raw !== null && state.source !== "raw") lines.push(t("srv.model.menu.invalidRaw"));
  if (state.profileName !== null && state.source === "default") lines.push(t("srv.model.menu.unavailable"));
  lines.push(t("srv.model.menu.next"), t("srv.model.menu.help"));
  return lines.join("\n");
};

const showPage = async (msg: IncomingMessage, token: string, menu: Menu, page: number): Promise<void> => {
  const pages = Math.max(1, Math.ceil(menu.names.length / PAGE_SIZE));
  const start = page * PAGE_SIZE;
  const names = menu.names.slice(start, start + PAGE_SIZE);
  const options = [{ label: t("srv.model.menu.useDefault"), value: `/model select ${token} -1` }];
  const pools: string[] = [];
  names.forEach((name, i) => {
    options.push({ label: clip(name, 60), value: `/model select ${token} ${start + i}` });
    pools.push(`${clip(name, 65)}: ${clip(poolText(resolveSessionProfilePool(name)), 120)}`);
  });
  if (page > 0) options.push({ label: t("srv.model.menu.previous"), value: `/model page ${token} ${page - 1}` });
  if (page + 1 < pages) options.push({ label: t("srv.model.menu.more"), value: `/model page ${token} ${page + 1}` });
  const text = [renderSessionModelStatus(msg), "", t("srv.model.menu.page", { page: page + 1, pages }), ...pools].join("\n");
  if (msg.presentOptions !== undefined) {
    const result = await presentAndClose(msg, text, options, {});
    if (result.ok) return;
  }
  await replyCommand(msg, `${text}\n\n${options.map((o) => `${o.label}: ${o.value}`).join("\n")}`);
};

/** true면 처리 완료. false는 기존 provider:model/reset 핸들러로 넘긴다. */
export const handleModelMenu = async (msg: IncomingMessage, args: string): Promise<boolean> => {
  if (args !== "" && !/^(select|page)(?:\s|$)/.test(args)) return false;
  try {
    const now = Date.now();
    for (const [key, menu] of menus) if (menu.expires <= now) menus.delete(key);
    if (args === "") {
      const who = owner(msg);
      for (const [key, menu] of menus) if (menu.owner === who) menus.delete(key);
      const token = randomBytes(12).toString("hex");
      const menu: Menu = {
        owner: who, sessionId: msg.threadKey, binding: binding(msg),
        // 대시보드에서 기본 항목은 상속 옵션이 대표한다. 기존 aliases도 같은 정규화 사용.
        names: listSessionModelProfiles().profiles.filter((p) => !p.isDefault).map((p) => p.name),
        expires: now + MENU_TTL,
      };
      menus.set(token, menu);
      if (menus.size > MENU_CAP) menus.delete(menus.keys().next().value!);
      await showPage(msg, token, menu, 0);
      return true;
    }
    const match = /^(select|page) ([a-f0-9]{24}) (-?\d{1,6})$/.exec(args);
    const token = match?.[2] ?? "";
    const menu = menus.get(token);
    if (match === null || menu === undefined || menu.owner !== owner(msg) || menu.sessionId !== msg.threadKey || menu.binding !== binding(msg)) {
      await replyCommand(msg, t("srv.model.menu.expired"));
      return true;
    }
    const index = Number(match[3]);
    if (match[1] === "page") {
      if (index < 0 || index >= Math.max(1, Math.ceil(menu.names.length / PAGE_SIZE))) {
        await replyCommand(msg, t("srv.model.menu.expired"));
      } else await showPage(msg, token, menu, index);
      return true;
    }
    const name = index === -1 ? "" : menu.names[index];
    // 선택할 때 목록 삭제를 alias 판정보다 먼저 검사한다. 정렬 후에도 발급 시 이름을 사용한다.
    if (name === undefined || (name !== "" && !listSessionModelProfiles().profiles.some((p) => p.name === name))) {
      await replyCommand(msg, t("srv.model.menu.expired"));
      return true;
    }
    // 검증→원자 저장→소비 사이 await를 두지 않는다. 실패 시 기존 raw/profile이 모두 남는다.
    applySessionModelProfile(canonicalSessionChannel(msg.threadKey, msg.channel), msg.threadKey, name);
    menus.delete(token);
    await replyCommand(msg, `${t("srv.model.menu.selected")}\n${renderSessionModelStatus(msg)}`);
  } catch {
    await replyCommand(msg, t("srv.model.menu.failed"));
  }
  return true;
};
