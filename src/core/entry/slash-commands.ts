// src/core/entry/slash-commands.ts
/**
 * 슬래시 명령 **본문** — 진입 핸들러에서 꺼낸 자리 (2026-09-05 구조 감사 ③).
 *
 * ★왜 옮겼나: `src/index.ts` 의 `handler` 가 1,301줄이었고 **그중 735줄이 이 블록 하나**
 *  였다. 판정 기준은 줄 수가 아니라 «고칠 때 헤매는가» 인데, 명령 하나를 고치려면 부팅·
 *  라우팅·훅·egress 가 뒤섞인 1,300줄에서 자리를 먼저 찾아야 했다.
 *
 * ★**조건은 저쪽에 남기고 본문만 왔다.** 각 함수는 `Promise<void>` 라 안의 `return;` 이
 *  한 글자도 안 바뀌었다 — 「처리했으니 그만」이 그대로다(호출부가 곧바로 `return;` 한다).
 *  조건까지 옮겨 boolean 을 돌려주게 했다면 그 `return;` 을 전부 고쳐야 했고, 그중 하나가
 *  콜백 안이면 **타입체커가 못 잡는 조용한 의미 변화**가 된다.
 *
 * ★**폴스루는 안 옮겼다** — 모르는 `/foo` 를 `expandCommand` 로 확장하고 못 찾으면 그대로
 *  LLM 으로 흘리는 꼬리는 진입점에 남는다. 그건 «명령 처리» 가 아니라 «명령이 아니었다» 는
 *  판정이라 자리가 다르다.
 *
 * ★문맥은 **한 벌**이다(`SlashCtx`) — 군집마다 다른 모양을 만들면 그게 곧 중복이다.
 *  실측: 9개 중 7개가 `msg`·`args` 만 쓰고 `/sessions` 가 `trimmed`, `/status` 가
 *  `sidChannel` 을 **읽기만** 한다.
 */
import type { IncomingMessage } from "../../channels/types.js";
import { getChannelPresence } from "../channel-registry.js";
import { backupInfo } from "../../store/backup.js";
import { addMemory, countArchivedMemories, deleteMemory, listMemories } from "../../store/memory.js";
import { presentAndClose, replyCommand } from "./reply-command.js";
import { getEventBus } from "../eventbus.js";
import { route } from "../router.js";
import { expandCommand, isEphemeralCommandText, parseSlashCommand } from "../entry/command-registry.js";
import { getFirstUserText } from "../../store/chat-log.js";
import { randomUUID } from "node:crypto";
import { clearChannelSessionBinding, getChannelSessionBinding, setChannelSessionBinding, setSessionArchived } from "../../store/channel-session.js";
import { DEFAULT_SESSION_ID } from "../threadkey.js";
import { collectInventory, formatInventoryForUser } from "../plugins/inventory.js";
import { contextPressureLabel, lookupContextWindow } from "../llm-runtime/context-windows.js";
import { deleteSchedule, listSchedules, updateSchedule } from "../../store/schedules.js";
import { SESSION_STORAGE_CHANNEL, getSession, getThreadName, listThreads, sessionDisplayName, setThreadName } from "../../store/sessions.js";
import { clearCooldowns, resolveModelSpecs } from "../llm-runtime/index.js";
import { appBuildId, appVersion } from "../version.js";
import { getPaths } from "../paths.js";
import { readSystem } from "../identity.js";
import { getCodexTokenExpiry } from "../llm-runtime/adapters/openai-codex-oauth.js";
import { listActiveCooldowns } from "../llm-runtime/index.js";
import { countMemories } from "../../store/memory.js";
import { getSessionModelOverride } from "../../store/sessions.js";

/** 명령 본문이 진입점에서 받는 것 — 한 벌만 둔다. */
export interface SlashCtx {
  readonly msg: IncomingMessage;
  /** 명령 뒤 인자(`parseSlashCommand` 산출). */
  readonly args: string;
  /** 원문 전체(공백 제거) — `/sessions` 하위명령 판정. */
  readonly trimmed: string;
  /** 세션 좌표 해석용 채널 — `/status` 가 읽는다. */
  readonly sidChannel: string;
}

export const handleMemo = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed, sidChannel } = ctx;
    if (args === "") {
      await replyCommand(msg,"`/memo <기억할 내용>` 형태로 입력하세요.");
      return;
    }
    // 자동 type='user' 고정 (V1 daemon 슬래시는 사용자 직접 입력 → 대부분 사용자 자신 정보).
    // 자동 type 분류는 V2 LLM (region 책임).
    const firstLine = args.split(/\r?\n/, 1)[0]?.trim() ?? args;
    const slug = `memo-${Date.now().toString(36)}`;
    try {
      const m = addMemory({
        type: "user",
        name: slug,
        description: firstLine,
        body: args,
      });
      await replyCommand(msg,`메모리 추가됨: ${m.name} — ${m.description}`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await replyCommand(msg,`메모리 추가 실패: ${err}`);
    }
    return;
};

export const handleForget = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed, sidChannel } = ctx;
    if (args === "") {
      await replyCommand(msg,"`/forget <name>` 형태로 입력하세요.");
      return;
    }
    // 단일 토큰 가정 (공백 없는 name, V1 단순). 다중 토큰은 첫 토큰만 사용.
    const name = args.split(/\s+/, 1)[0] ?? args;
    try {
      const ok = deleteMemory(name);
      await replyCommand(msg,
        ok ? `메모리 삭제됨: ${name}` : `그런 메모리가 없습니다: ${name}`,
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await replyCommand(msg,`메모리 삭제 실패: ${err}`);
    }
    return;
};

export const handleMemos = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed, sidChannel } = ctx;
    // 인자 옵셔널 (기본 10, 1~50 클램프). 숫자 아니면 기본 10.
    let limit = 10;
    if (args !== "") {
      const parsed = parseInt(args, 10);
      if (!Number.isNaN(parsed)) {
        limit = Math.max(1, Math.min(50, parsed));
      }
    }
    try {
      const list = listMemories({ limit, orderBy: "updated" });
      if (list.length === 0) {
        await replyCommand(msg,"저장된 메모리 없음.");
      } else {
        const lines = list.map(
          (m) => `[${m.type}] ${m.name} — ${m.description}`,
        );
        await replyCommand(msg,lines.join("\n"));
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      await replyCommand(msg,`메모리 목록 조회 실패: ${err}`);
    }
    return;
};

export const handleSchedule = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed, sidChannel } = ctx;
    // /schedule list | delete <id> | enable <id> | disable <id>
    // add 는 V1 미포함 — 인용 파싱 회피, 비서 자연어 MCP tool 권장.
    const subSepIdx = args.search(/\s/);
    const sub = subSepIdx === -1 ? args : args.slice(0, subSepIdx);
    const subArgs =
      subSepIdx === -1 ? "" : args.slice(subSepIdx + 1).trim();

    if (sub === "" || sub === "list") {
      try {
        const items = listSchedules();
        if (items.length === 0) {
          await replyCommand(msg,"등록된 스케줄 없음.");
        } else {
          const lines = items.map((s) => {
            const status =
              s.lastStatus === null
                ? "—"
                : s.lastStatus === "ok"
                  ? "ok"
                  : `err: ${s.lastError ?? "?"}`;
            const en = s.enabled ? "on" : "off";
            const dest =
              s.destTarget !== null && s.destTarget.length > 0
                ? `${s.destChannel}:${s.destTarget}`
                : s.destChannel;
            const triggerPart =
              s.triggerType === "reboot"
                ? "reboot"
                : `cron (${s.cronExpr} | ${s.timezone})`;
            return `#${s.id} [${en}] ${s.label} ${triggerPart} → ${dest} | last: ${status}`;
          });
          await replyCommand(msg,lines.join("\n"));
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await replyCommand(msg,`스케줄 목록 조회 실패: ${err}`);
      }
      return;
    }

    if (sub === "add") {
      await replyCommand(msg,
        "`/schedule add` 는 V1 슬래시에서 미지원. 비서에게 자연어로 부탁하세요 (예: \"매일 8시에 뉴스 정리해서 텔레그램으로\"). 비서가 add_schedule MCP 도구로 등록합니다.",
      );
      return;
    }

    // 그 외 subcommand 는 id 필요
    const id = parseInt(subArgs, 10);
    if (Number.isNaN(id)) {
      await replyCommand(msg,
        "`/schedule <list|delete|enable|disable> <id>` 형태로 입력하세요.",
      );
      return;
    }

    if (sub === "delete") {
      try {
        const ok = deleteSchedule(id);
        if (ok) {
          // scheduler runner 에게 cron 객체 stop 통보. scheduler plugin 이
          // subscribe 해서 처리. EventBus 의 격리 try/catch 가 publish 실패도 흡수.
          try {
            getEventBus().publish({
              type: "scheduler.toggle",
              ts: Date.now(),
              payload: { id, action: "delete" },
            });
          } catch {
            /* bus throw — ignore */
          }
          await replyCommand(msg,`스케줄 삭제됨: #${id}`);
        } else {
          await replyCommand(msg,`그런 스케줄이 없습니다: #${id}`);
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await replyCommand(msg,`스케줄 삭제 실패: ${err}`);
      }
      return;
    }

    if (sub === "enable" || sub === "disable") {
      const enable = sub === "enable";
      try {
        const updated = updateSchedule(id, { enabled: enable });
        if (updated === undefined) {
          await replyCommand(msg,`그런 스케줄이 없습니다: #${id}`);
        } else {
          try {
            getEventBus().publish({
              type: "scheduler.toggle",
              ts: Date.now(),
              payload: { id, action: enable ? "enable" : "disable" },
            });
          } catch {
            /* bus throw — ignore */
          }
          await replyCommand(msg,
            `스케줄 #${id} ${enable ? "활성화" : "비활성화"}됨.`,
          );
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await replyCommand(msg,`스케줄 토글 실패: ${err}`);
      }
      return;
    }

    await replyCommand(msg,
      "`/schedule <list|delete|enable|disable> [id]` — 알 수 없는 subcommand.",
    );
    return;
};

export const handleSessions = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed, sidChannel } = ctx;
    // ★휘발성 여부는 **하나의 판정**이 정한다 (2026-08-23 2라운드 E1). 인바운드 에코를
    //  건너뛰는 판단(`handler` 최상단)과 응답을 안 남기는 판단이 갈리면 **반쪽만 휘발**
    //  한다: 종전엔 `{ephemeral:true}` 가 성공 분기 둘에만 붙어 있어서, 오류 분기와
    //  대시보드가 늘 타는 선택지 분기에선 **명령은 사라지고 답만 남았다** — 고치려던
    //  버그의 거울상이다. 여기서 한 번 정하고 이 블록의 모든 응답이 그 값을 쓴다.
    const ephemeral = isEphemeralCommandText(trimmed);
    // 대화방 주소 — 바인딩(use/new)에만 필요. archive/unarchive 는 채널 무관이라
    // 아래 가드보다 먼저 처리된다(대시보드에서도 세션 정리가 돼야 한다).
    const addr = msg.channelAddress?.trim() ?? "";
    const sub = parseSlashCommand(trimmed).sub; // 같은 파서 — 판정과 갈릴 수 없다.
    const rest = args === "" ? "" : args.slice(sub.length).trim();
    const current = (() => {
      try {
        return getChannelSessionBinding(msg.channel, addr) ?? DEFAULT_SESSION_ID;
      } catch {
        return DEFAULT_SESSION_ID;
      }
    })();
    const nameOf = (id: string): string => {
      // ★**키로 한 건만 읽는다** (2026-08-24 6라운드). 5라운드엔 `includeArchived: true`
      //  로 고쳤는데 그게 `listThreads` 의 **기본 상한 100** 과 만나 같은 결함을
      //  되살렸다 — 실측: 활성 120 · 보관 5 → 복원 목록 이름 **5/5 유실**. 보관은
      //  `last_used_at` 을 안 건드리므로 활성·보관이 한 창을 두고 경쟁한다.
      //  상한을 키우는 건 답이 아니다(500 도 500에서 같은 결함을 낸다).
      //  질문이 "이 키의 이름" 이면 **키로 물어야 한다.**
      const name = getThreadName(id);
      // ★키 원문을 뱉지 않는다 — 종전엔 이름이 없으면 `dashboard:1784104932394-f791d2b408d6`
      //  가 그대로 목록에 떴다("이름 없는 세션" 의 정체). 파생 규칙은 대시보드와 공용.
      return sessionDisplayName(id, name, getFirstUserText(id));
    };

    // /sessions archive [id] — 목록에서 숨긴다. ★삭제가 아니다(대화 기록 보존, 복원 가능).
    //  인자 없으면 선택지로 고르게 한다(값 = `/sessions archive <id>`).
    if (sub === "archive" || sub === "unarchive") {
      const restoring = sub === "unarchive";
      const id = rest.trim();
      if (id !== "") {
        if (!restoring && id === DEFAULT_SESSION_ID) {
          await replyCommand(msg, "기본 세션은 보관할 수 없습니다(항상 존재하는 세션입니다).",
            { ephemeral },
          );
          return;
        }
        // ★보관 = 그 세션을 가리키는 **모든 방**의 바인딩 해제까지가 한 동작이다
        //  (2026-07-29 검토). 종전엔 명령을 보낸 방 하나만 봐서 다른 방은 목록에 없는
        //  세션에 계속 쌓았다. ★그 판단을 세 입구(명령·도구·엔드포인트)가 각자 갖고
        //  있다가 실제로 갈렸으므로(대시보드 탭 닫기 경로엔 아예 없었다) 이제 셋이
        //  `setSessionArchived` 하나를 부른다.
        const { changed, unboundRooms } = setSessionArchived(id, !restoring);
        if (changed === 0) {
          await replyCommand(msg, `그런 세션이 없습니다: ${id}`,
            { ephemeral },
          );
          return;
        }
        const note =
          unboundRooms > 0
            ? `\n그 세션에 묶여 있던 대화방 ${unboundRooms}곳을 **기본 세션**으로 되돌렸습니다.`
            : "";
        await replyCommand(
          msg,
          restoring
            ? `복원했습니다 — 목록에 다시 나옵니다.`
            : `보관했습니다 — 목록에서 숨깁니다. **대화 기록은 그대로 남아 있고** \`/sessions unarchive\` 로 되돌릴 수 있습니다.${note}`,
          { ephemeral },
        );
        return;
      }
      const pool = restoring
        ? listThreads({ excludeInternal: true, onlyArchived: true, limit: 20 })
        : listThreads({ excludeInternal: true, limit: 20 }).filter(
            (t: { threadKey: string }) => t.threadKey !== DEFAULT_SESSION_ID,
          );
      if (pool.length === 0) {
        await replyCommand(msg, restoring ? "보관된 세션이 없습니다." : "보관할 세션이 없습니다.",
          { ephemeral },
        );
        return;
      }
      const opts2 = pool.map((t: { threadKey: string }) => ({
        label: nameOf(t.threadKey),
        value: `/sessions ${sub} ${t.threadKey}`,
      }));
      const q = restoring ? "어떤 세션을 복원할까요?" : "어떤 세션을 보관할까요?";
      {
        const r = await presentAndClose(
          msg,
          q,
          opts2,
          {
            note: restoring
              ? "복원하면 목록에 다시 나옵니다."
              : "보관 = 목록에서 숨김. 대화 기록은 지우지 않습니다(되돌리기 가능).",
          },
          { ephemeral },
        );
        if (r.ok) return;
        console.warn(`/sessions ${sub} 선택지 렌더 실패 — 텍스트 폴백: ${r.error ?? "(사유 없음)"}`);
      }
      await replyCommand(
        msg,
        `${q}\n${opts2.map((o) => `· ${o.label} — \`${o.value}\``).join("\n")}`,
        { ephemeral },
      );
      return;
    }

    // ★셀렉터가 이미 있는 채널(대시보드)은 대상이 아니다. 그런 채널은 매 요청에
    //  explicitSessionId 를 실어 보내므로 바인딩이 **무시**되고(resolveSessionId 가 explicit
    //  우선), 게다가 http-bridge 는 channelAddress = threadKey 라 "세션이 자기를 가리키는"
    //  무의미한 행만 남는다(개발 중 실측). 조용히 되게 두면 "묶었습니다" 라고 답해 놓고
    //  아무 일도 안 일어난다 = 오늘 종일 고친 조용한 실패 부류. 명시적으로 거절한다.
    // ★explicit 유무가 아니라 **세션 정규화 자체**로 판정한다 (2026-07-29 검토).
    //  종전엔 explicitSessionId 가 있을 때만 거절했는데, http-bridge 는 threadKey 를 안 준
    //  요청에선 explicit 도 addr 도 없이 들어온다 → 가드를 통과해 바인딩 행을 쓰고
    //  "묶었습니다" 라 답하지만 그 채널은 바인딩을 **절대 읽지 않는다**(항상 explicit 를
    //  실어 보내므로) = 죽은 쓰기 + 거짓 확인. 심지어 그렇게 띄운 선택지를 대시보드에서
    //  누르면 이번엔 가드가 거절한다 — 자기가 띄운 걸 자기가 거절(검토 실측).
    //  기준: 세션 셀렉터를 가진 채널(session.explicitSessionId 를 쓰는 계열) 전체를 거절.
    const hasSelector =
      msg.channel === SESSION_STORAGE_CHANNEL ||
      (msg.session?.explicitSessionId !== undefined && msg.session.explicitSessionId !== "");
    if (hasSelector) {
      await replyCommand(
        msg,
        "이 채널은 이미 세션 셀렉터가 있습니다 — 대시보드 상단 탭에서 세션을 고르세요. `/sessions` 는 셀렉터가 없는 채널(텔레그램·CLI)용입니다.",
        { ephemeral },
      );
      return;
    }
    if (addr === "") {
      await replyCommand(
        msg,
        "이 채널은 대화방 주소가 없어 세션을 묶을 수 없습니다.",
        { ephemeral },
      );
      return;
    }
    // /sessions use <id> — 선택지 버튼이 돌려보내는 값이자 수동 입력 경로.
    if (sub === "use" && rest !== "") {
      const target = rest.trim();
      if (target === DEFAULT_SESSION_ID || target === "default") {
        clearChannelSessionBinding(msg.channel, addr);
        await replyCommand(msg, "이 대화방을 **기본 세션**으로 되돌렸습니다.",
          { ephemeral },
        );
        return;
      }
      // ★존재 판정에 **목록용 필터를 쓰지 않는다** (2026-07-29 검토). 표시 정책과 존재
      //  여부는 다른 질문이다 — 표시 필터로 존재를 판정하면 방금 만든 세션이 "그런 세션이
      //  없습니다" 가 된다(내 필터가 내 기능을 막았다). 그 표시 필터(excludeProbes)는
      //  2026-08-09 에 폐지됐지만, **판단 분리 자체는 유효하다**(보관은 아직 숨긴다).
      //  보관된 세션도 존재는 한다(복원 대상) → includeArchived.
      const exists = listThreads({ excludeInternal: true, includeArchived: true, limit: 500 }).some(
        (x: { threadKey: string }) => x.threadKey === target,
      );
      if (!exists) {
        await replyCommand(
          msg,
          `그런 세션이 없습니다: ${target}\n\`/sessions\` 로 목록을 확인하세요.`,
          { ephemeral },
        );
        return;
      }
      setChannelSessionBinding(msg.channel, addr, target);
      // 이 방의 설정 확인 — 휘발성(그 채널에 한 번 보이고 안 남는다).
      await replyCommand(
        msg,
        `이 대화방을 **${nameOf(target)}** 세션에 묶었습니다. 앞으로 이 방의 대화는 그 세션에 쌓입니다(재시작해도 유지).`,
        { ephemeral },
      );
      return;
    }

    // /sessions new [이름] — 새 세션 생성 + 즉시 바인딩(텔레그램만 쓰는 경우의 유일한 생성 수단).
    if (sub === "new") {
      // id 형식은 대시보드 새 탭과 동일(`dashboard:<uuid>`). 접두는 채널 참조가 아니라
      // ADR 이 명시한 **opaque 레거시 물리 키** 라, 같은 네임스페이스를 쓰는 게 맞다.
      const sid = `dashboard:${randomUUID()}`;
      setChannelSessionBinding(msg.channel, addr, sid);
      const wanted = rest.trim();
      // ★이름을 안 줘도 행을 만든다 (2026-07-29). 종전엔 이름이 있을 때만 setThreadName 이
      //  placeholder 를 만들어서, 무명 new 는 threads 행이 아예 없었다 → 목록에도 안 뜨고
      //  보관도 "그런 세션이 없습니다". 만든 즉시 다룰 수 있어야 만든 것이다.
      //  이름 없으면 번호식 기본명을 준다(대시보드 "세션N" 관례와 같은 의도).
      const finalName = wanted !== "" ? wanted : `세션 ${new Date().toLocaleDateString("ko-KR")}`;
      {
        try {
          setThreadName(sid, finalName); // 행이 없으면 placeholder 를 만들어 이름 보존.
        } catch (e) {
          console.warn(
            `세션 이름 저장 실패(세션은 생성됨): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      // 같은 부류 — 바인딩 확인이지 대화가 아니다. 휘발성.
      await replyCommand(
        msg,
        `새 세션 **${finalName}** 을 만들고 이 대화방을 묶었습니다.`,
        { ephemeral },
      );
      return;
    }

    // 인자 없음 — 현재 세션 + 선택지. 선택 UI 가 없는 채널(값 미지원)엔 목록 텍스트로 폴백.
    //
    // ★**이름 붙인 세션만** 뿌린다 (2026-08-22 사용자 신고: "대시보드엔 안 뜨는 애들이
    //  텔레그램엔 뜬다. 대시보드가 맞다"). 대시보드 탭은 `shouldAutoOpenTab` =
    //  `name` 이 있는 것만 여는데 여기는 전부 뿌려서, 이름을 안 붙인 세션이 **첫 발화
    //  파생 라벨**로 끼었다(`#VoxelBuilder 깃풀…` 처럼 태그로 시작하면 아예 무의미하다).
    //  같은 질문("어느 세션에 묶을까")에 두 화면이 다른 답을 주고 있었다.
    //
    // ★2026-08-09 에 폐지한 "짧은 대화 숨기기" 와는 다른 규칙이다. 그건 **길이**로
    //  추측해서 갓 시작한 진짜 대화를 지웠다. 이건 **사용자가 이름을 붙였는가** — 의도의
    //  표현이지 추측이 아니다. 대시보드가 이미 그 규칙으로 돌고 사용자가 맞다고 했다.
    //
    // ★현재 세션은 이름이 없어도 **항상 남긴다** — 지금 어디 묶여 있는지는 보여야 한다.
    // ★숨긴 개수는 **말한다**(아래 note). 조용히 접히면 사용자는 없어진 줄 안다.
    const allThreads = listThreads({ excludeInternal: true });
    const threads = allThreads
      .filter(
        (t: { threadKey: string; name?: string | null }) =>
          (t.name ?? "").trim() !== "" || t.threadKey === current,
      )
      .slice(0, 20);
    const hiddenCount = allThreads.length - threads.length;
    const options = [
      // ★기본 세션도 **이름 규칙을 그대로 탄다**(2026-08-19 사용자 신고: "기본세션은
      //  텔레그램에서 바뀐 이름이 안 나오고 계속 기본 세션으로 나온다").
      //  여기만 문자열이 박혀 있어서, 같은 화면의 헤더는 `nameOf(current)` 로 "공통" 을
      //  보여주는데 **첫 버튼만 "기본 세션"** 이었다 — 한 목록에서 두 규칙이 돌았다.
      //  `sessionDisplayName` 은 이미 "사용자 지정 > 고정 라벨" 순서라(2026-08-07 에 바로
      //  이 부류로 한 번 고쳤다), 규칙을 부르기만 하면 이름을 안 붙였을 때 "기본 세션" 도
      //  그대로 나온다. 라벨을 손으로 적는 순간 규칙 밖으로 나간다.
      {
        label: `${nameOf(DEFAULT_SESSION_ID)}${current === DEFAULT_SESSION_ID ? " ✅" : ""}`,
        value: `/sessions use ${DEFAULT_SESSION_ID}`,
      },
      ...threads
        .filter((t: { threadKey: string }) => t.threadKey !== DEFAULT_SESSION_ID)
        .map((t: { threadKey: string }) => ({
          label: `${nameOf(t.threadKey)}${t.threadKey === current ? " ✅" : ""}`,
          value: `/sessions use ${t.threadKey}`,
        })),
    ];
    const header = `현재 세션: **${nameOf(current)}**`;
    // ★잘린 것을 **말한다** — 조용히 접히면 사용자는 세션이 사라진 줄 안다. 되찾는 법도
    //  같이 준다(이름을 붙이면 목록에 올라온다 = 대시보드 탭 규칙과 동일).
    //  ★안내는 **실재하는 수단만** 적는다. `/sessions` 하위명령은 `use|new|archive|
    //   unarchive` 뿐이고 `rename` 은 없다 — 이름 붙이기는 대시보드나 자연어(비서에게
    //   말하기)로 한다. 없는 명령을 적으면 사용자가 그걸 치고 막힌다.
    const hiddenNote =
      hiddenCount > 0
        ? `\n이름 없는 세션 ${hiddenCount}개는 숨겼어요 — 이름을 붙이면 나옵니다("이 세션 이름 …로 해줘").`
        : "";
    if (msg.presentOptions !== undefined && options.length > 1) {
      // ★정리 수단을 **여기서** 알려준다 (2026-08-22 사용자 신고). 종전엔 `new` 만 적혀
      //  있어서, 안 쓰는 세션을 없애려던 사용자가 `/clear` 로 갔다 — 그건 컨텍스트만
      //  지우고 세션은 남긴다("이름·설정은 그대로예요"). 그래서 같은 이름을 다시 만들어
      //  **목록에 같은 이름이 둘** 남았다. 능력(`archive`)은 있었는데 닿을 길이 없었다.
      //  목록을 보는 그 순간이 정리하고 싶어지는 순간이므로, 안내도 그 자리에 둔다.
      const r = await presentAndClose(
        msg,
        "이 대화방을 어느 세션에 묶을까요?",
        options,
        {
          note:
            `${header}\n새로 만들기 \`/sessions new [이름]\` · 목록에서 숨기기 \`/sessions archive\`` +
            hiddenNote,
        },
        { ephemeral },
      );
      if (r.ok) return;
      // 렌더 실패 — 조용히 넘기지 않고 텍스트로 폴백(선택지가 사라지는 사고 방지).
      console.warn(`/sessions 선택지 렌더 실패 — 텍스트 폴백: ${r.error ?? "(사유 없음)"}`);
    }
    const lines = options.map((o) => `· ${o.label} — \`${o.value}\``);
    await replyCommand(
      msg,
      `${header}\n\n${lines.join("\n")}\n\n새로 만들기: \`/sessions new [이름]\`` +
        ` · 목록에서 숨기기: \`/sessions archive\`${hiddenNote}`,
      { ephemeral },
    );
    return;
};

export const handleCompact = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed, sidChannel } = ctx;
    const { compactThreadNow } = await import(
      "../llm-runtime/adapters/openai-codex-oauth-history.js"
    );
    const { resolveCodexModel } = await import(
      "../llm-runtime/adapters/openai-codex-oauth.js"
    );
    const { ensureFreshAccessToken, extractAccountId } = await import(
      "../llm-runtime/adapters/openai-codex-oauth-auth.js"
    );
    try {
      const token = await ensureFreshAccessToken();
      const r = await compactThreadNow(
        msg.channel,
        msg.threadKey,
        resolveCodexModel(),
        token,
        extractAccountId(token),
      );
      await replyCommand(
        msg,
        r.ok
          ? `🗜 압축했습니다 — 이전 ${r.foldedTurns}턴을 요약으로 접었습니다 ` +
            `(${r.foldedChars.toLocaleString()}자 → ${r.summaryChars.toLocaleString()}자).\n` +
            `최근 대화는 원문 그대로 유지됩니다.`
          : `압축하지 않았습니다 — ${r.reason}`,
      );
    } catch (e) {
      await replyCommand(
        msg,
        `압축 실패: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return;
};

export const handleCooldown = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed, sidChannel } = ctx;
    const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    const target = args.trim().slice(sub.length).trim();
    if (sub === "clear") {
      const cleared = clearCooldowns(target === "" ? undefined : target);
      await replyCommand(
        msg,
        cleared.length === 0
          ? target === ""
            ? "해제할 쿨다운이 없습니다."
            : `'${target}' 로 시작하는 쿨다운이 없습니다.`
          : `쿨다운 해제: ${cleared.join(", ")}\n다음 턴부터 그 백엔드를 다시 시도합니다.`,
      );
      return;
    }
    const live = listActiveCooldowns();
    if (live.length === 0) {
      await replyCommand(msg, "쿨다운 중인 백엔드가 없습니다.");
      return;
    }
    const lines = live.map((c) => {
      const mins = Math.round(c.remainingMs / 60000);
      const when = new Date(Date.now() + c.remainingMs).toLocaleString("ko-KR");
      return `· ${c.key} — ${mins >= 120 ? `${Math.round(mins / 60)}시간` : `${mins}분`} 남음 (해제 ${when})`;
    });
    await replyCommand(
      msg,
      `쿨다운 중인 백엔드:\n${lines.join("\n")}\n\n` +
        "재인증했거나 한도가 풀렸으면 `/cooldown clear` 로 즉시 해제하세요(대상 지정: `/cooldown clear codex`).",
    );
    return;
};

export const handlePlugins = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed, sidChannel } = ctx;
    // 인자 무 (V1). 라우터 우회 — 인벤토리 직접 조회 후 사용자 포맷으로 응답.
    try {
      const inv = await collectInventory();
      const text = formatInventoryForUser(inv);
      await replyCommand(msg,text);
    } catch (e) {
      console.error("plugins inventory failed:", e);
      const err = e instanceof Error ? e.message : String(e);
      await replyCommand(msg,`인벤토리 조회 실패: ${err}`);
    }
    return;
};

export const handleStatus = async (ctx: SlashCtx): Promise<void> => {
  const { msg, args, trimmed, sidChannel } = ctx;
    // 라우터 우회 — 데몬 현재 상태 직접 조회. 전부 DB/env/상수 읽기 (LLM 호출 0, route 미경유).
    try {
      const specs = resolveModelSpecs();
      const regionA = specs
        .map((s) => `${s.adapter}:${s.model || "(SDK 디폴트)"}`)
        .join(" → ");
      const sched = listSchedules();
      const enabled = sched.filter((s) => s.enabled).length;
      const up = Math.floor(process.uptime());
      const h = Math.floor(up / 3600);
      const m = Math.floor((up % 3600) / 60);
      const uptime = h > 0 ? `${h}시간 ${m}분` : `${m}분`;

      // 토큰 포맷 헬퍼: <1000 그대로, 86000→"86k", 1200000→"1.2M".
      const fmtTok = (n: number): string => {
        if (n < 1000) return String(n);
        if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
        return `${(n / 1_000_000).toFixed(1)}M`;
      };

      // 이번 대화: 이 thread 의 실제 모델 + 컨텍스트 사용량.
      const session = getSession(sidChannel, msg.threadKey);
      let convo: string;
      if (session === undefined || session.model === null) {
        convo = "측정 전(아직 응답 없음)";
      } else if (session.lastInputTokens === null) {
        convo = `${session.model} · 컨텍스트 측정 전`;
      } else {
        const inTok = session.lastInputTokens;
        const win = lookupContextWindow(session.model);
        if (win !== undefined) {
          const pct = Math.round((inTok / win) * 100);
          // 컨텍스트 압박 경고 — 판정은 `context-windows.ts` 가 소유한다(회귀 대상).
          const warn = contextPressureLabel(pct);
          convo = `${session.model} · 컨텍스트 ~${pct}%${warn} (입력 ${fmtTok(inTok)} / ${fmtTok(win)})`;
        } else {
          convo = `${session.model} · 컨텍스트 입력 ${fmtTok(inTok)} (윈도우 미상)`;
        }
      }

      const lines = [
        "🐂 tiguclaw 상태",
        // 빌드 식별자 — "업데이트를 받았나" 를 한 줄로 가르는 유일한 수단(버전은 마일스톤
        // 에서만 오르므로 같은 v0.15.0 이 30커밋 차이일 수 있다).
        // ★낡은 빌드 경고는 뺐다 (2026-08-02 사용자 판단) — **독자가 행동할 수 없는 말**이라서다.
        //  이 데몬은 개발 대상이면서 동시에 사용자의 실사용 비서라, 소스를 고치는 동안 격차가
        //  상시 생긴다. 사용자에겐 할 일이 없는 경고가 매번 뜬다(배경소음). 원래 막던 사고
        //  ("업데이트가 조용히 반영 안 됨")는 `/update` 쪽에 그물이 있다 — typecheck 게이트 →
        //  자동 롤백 → 실패 통지(위임 실행은 마커파일로 재가동 후 통지, selfupdate-rollback-safety).
        //  해시는 남긴다: 평소엔 조용하고 **사고 때** "어느 코드가 도는가" 에 답하는 유일한 값이다.
        `─ 버전: v${appVersion()}${appBuildId() !== "" ? ` · 빌드 ${appBuildId()}` : ""}`,
        `─ 업타임: ${uptime}`,
        `─ 이번 대화: ${convo}`,
      ];

      // 세션 override (`/model` 로 설정) — 있을 때만 표시. 풀보다 우선이므로
      // 풀 줄 위에 둬서 사용자가 "다음 turn 무엇이 도는지" 즉시 파악.
      const statusOverride = getSessionModelOverride(
        sidChannel,
        msg.threadKey,
      );
      if (statusOverride !== null) {
        lines.push(
          `─ 세션 모델 override: \`${statusOverride}\` (다음 turn 부터 — 풀 무시, \`/model reset\` 해제)`,
        );
      }

      // ★작동 헌법 부재 — 있을 때만 표시(0이면 생략, 배경소음 금지). 판단 규칙을 SYSTEM.md
      //  한 곳으로 모은 뒤로 **부재 = 위임·동사·확인 규칙 0** 인데 그 상태가 조용해서,
      //  부팅 로그와 함께 여기에도 든다(사용자가 조치할 수 있는 사실이다).
      if (Buffer.byteLength(readSystem(), "utf8") === 0) {
        lines.push(
          `─ ⚠️ 작동 헌법을 읽지 못했습니다 (${getPaths().systemMd}) — 판단 규칙 없이 도는 중입니다`,
        );
      }

      lines.push(`─ 모델 풀: ${regionA}`);

      // ★쿨다운 표시 (2026-07-27) — 풀에 있어도 *지금은 안 쓰이는* 모델을 알린다.
      //  실사고: ChatGPT Plus 주간 한도 소진으로 codex 가 6일 쿨다운에 들어갔는데
      //  폴백(claude)이 조용히 받아내 사용자는 로그를 뒤지기 전엔 알 수 없었다.
      //  ★푸시는 하지 않는다(폴백이 정상 동작 = 알림은 노이즈, 사용자 판단).
      //  물어봤을 때 보이면 충분하다. 없으면 줄 자체 생략(정상 시 노이즈 0).
      const cooldowns = listActiveCooldowns();
      for (const c of cooldowns) {
        const mins = Math.round(c.remainingMs / 60000);
        const when =
          mins >= 1440
            ? `${(mins / 1440).toFixed(1)}일`
            : mins >= 60
              ? `${Math.floor(mins / 60)}시간 ${mins % 60}분`
              : `${mins}분`;
        const at = new Date(Date.now() + c.remainingMs);
        const stamp = `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, "0")}시`;
        lines.push(
          `─ ⏸ \`${c.key}\` 사용 불가 — ${when} 뒤 복구(${stamp}경). 그동안 풀의 다음 모델로 대체됩니다.`,
        );
      }

      // codex 토큰 만료: 미설정(undefined)이면 줄 자체 생략.
      const expiry = getCodexTokenExpiry();
      if (expiry !== undefined) {
        const days = Math.floor((expiry - Date.now()) / 86_400_000);
        const d = new Date(expiry);
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const warn = days < 2 ? "⚠️ " : "";
        lines.push(`─ ${warn}codex 토큰: ${days}일 후 만료 (${ymd})`);
      }

      lines.push(`─ 메모리: ${countMemories()}개`);
      // ★내려둔 것(아카이브)은 매 턴 안 실린다 — 그래서 «쌓였나» 는 여기서 한 번 말한다.
      //  미열람이 0이면 줄 자체를 만들지 않는다(할 말이 없으면 안 하는 게 낫다).
      {
        const arch = countArchivedMemories();
        if (arch.unread > 0) {
          lines.push(
            `─ 내려둔 메모리: ${arch.total}건 (미열람 ${arch.unread} — 자가성장 제안 포함, \`search_memory\` 로 봅니다)`,
          );
        }
      }
      lines.push(
        `─ 채널: ${getChannelPresence().map((c) => c.name).join(", ")} (${getChannelPresence().length})`,
      );
      lines.push(`─ 스케줄: ${sched.length}개 (활성 ${enabled})`);

      // ★백업은 **밀지 않고 여기서 보여준다** (2026-08-11 사용자 결정) — 매일 성공
      //  알림은 배경 소음이 되고 그러면 진짜 신호가 묻힌다. 알림은 놓치면 끝이지만
      //  `/status` 는 궁금할 때 언제나 있다.
      try {
        const b = backupInfo();
        if (b.latestAt === null) {
          lines.push("─ ⚠️ 백업: 아직 없음");
        } else {
          const mins = Math.floor((Date.now() - b.latestAt) / 60_000);
          const ago = mins < 60 ? `${mins}분 전` : `${Math.floor(mins / 60)}시간 전`;
          const mb = (b.totalBytes / 1_048_576).toFixed(0);
          const stale = mins > 48 * 60 ? "⚠️ " : "";
          lines.push(`─ ${stale}백업: ${ago} · ${b.count}벌 (${mb}MB)`);
        }
      } catch {
        /* 이 줄만 생략 — 상태 조회 전체를 무르지 않는다 */
      }

      await replyCommand(msg,lines.join("\n"));
    } catch (e) {
      console.error("status failed:", e);
      const err = e instanceof Error ? e.message : String(e);
      await replyCommand(msg,`상태 조회 실패: ${err}`);
    }
    return;
};