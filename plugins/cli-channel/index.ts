import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Channel, IncomingMessage, MessageHandler } from "../../src/channels/types.js";
import type { ChannelOutbound } from "../../src/core/channel-outbound.js";
import { resolveSessionId } from "../../src/core/threadkey.js";

export default class CliChannel implements Channel {
  readonly name = "cli" as const;
  /**
   * 아웃바운드 능력(ADR 2026-07-16 §D3, 3어댑터 parity) — deliver = console.log(현행 switch
   * cli 케이스 상당). defaultOutboundTarget = null(cli 는 배달 좌표 없음 — 로컬 콘솔).
   */
  readonly outbound: ChannelOutbound = {
    deliver: async (_target: string | null, text: string): Promise<void> => {
      console.log(text);
    },
    defaultOutboundTarget: (): string | null => null,
  };
  private rl: ReadlineInterface | null = null;

  async start(handler: MessageHandler): Promise<void> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });
    this.rl = rl;

    const reply = async (text: string): Promise<void> => {
      process.stdout.write(`${text}\n`);
      rl.prompt();
    };

    // 축1 선택지 — CLI 는 번호 목록으로 1회 렌더하고 즉시 반환(비차단). 다음 줄이 답이다.
    // 사용자가 바로 번호를 치면 그 보기의 value 로 치환해 router 로 흘려보낸다(텔레그램
    // callback / 대시보드 버튼 클릭과 동형 — value 가 다음 인바운드 text). 번호 아닌 입력은
    // 그대로 통과(자유 답변 허용). 다음 줄을 받으면 pending 은 소진(1회용).
    let pendingOptions: { label: string; value: string }[] | null = null;
    const presentOptions: IncomingMessage["presentOptions"] = async (
      question,
      options,
      opts,
    ) => {
      try {
        const lines = [
          question,
          ...options.map((o, i) => `  ${i + 1}) ${o.label}`),
        ];
        if (opts?.note !== undefined && opts.note.trim() !== "") {
          lines.push(`  (${opts.note})`);
        }
        lines.push("번호를 입력하거나 직접 답하세요.");
        process.stdout.write(`${lines.join("\n")}\n`);
        rl.prompt();
        pendingOptions = options;
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    };

    rl.on("line", (line) => {
      const raw = line.trim();
      if (raw.length === 0) {
        rl.prompt();
        return;
      }
      // pending 선택지가 있고 입력이 유효 번호면 그 value 로 치환(1회용 — 즉시 소진).
      let text = raw;
      if (pendingOptions !== null) {
        const opts = pendingOptions;
        pendingOptions = null;
        const n = Number.parseInt(raw, 10);
        if (Number.isInteger(n) && n >= 1 && n <= opts.length) {
          text = opts[n - 1]!.value;
        }
      }
      // 채널/세션 분리(ADR 2026-07-15) — cli 는 세션 셀렉터 없음 → 기본 세션(DEFAULT).
      // resolveSessionId 로 sessionId 를 구해 threadKey 에 세팅(직렬 큐/`/stop` 정합)하고,
      // session:{}(셀렉터·주소 없음) 을 실어 route 가 canonical (http-bridge, DEFAULT) 로
      // 세션-정체성을 정규화하게 한다 → 텔레그램/대시보드 기본 세션과 한 대화로 합류.
      // ★대화방 주소 부여 (2026-07-29) — CLI 는 터미널 하나가 곧 한 대화방이다. 종전엔
      //  주소가 없어 `/sessions` 가 "주소 없음" 으로 끝났는데, 명령 설명·안내문은 "텔레그램·
      //  **CLI**용" 이라고 광고하고 있었다(검토 지적). 고정 주소를 줘서 광고와 실제를 맞춘다.
      //  bindings 조회 키가 되므로 세션 선택이 재시작 뒤에도 유지된다(텔레그램과 동형).
      const CLI_ADDRESS = "local";
      const sessionId = resolveSessionId("cli", CLI_ADDRESS);
      const msg: IncomingMessage = {
        channel: "cli",
        channelUserId: "local",
        threadKey: sessionId,
        channelAddress: CLI_ADDRESS,
        session: { channelAddress: CLI_ADDRESS },
        text,
        receivedAt: Date.now(),
        reply,
        presentOptions,
      };
      // telegram.ts 와 동일한 격리: handler/reply 가 throw 해도 데몬은 산다 (원칙 3).
      void handler(msg).catch((e) => {
        console.error("cli handler error:", e);
      });
    });

    rl.prompt();
  }

  async stop(): Promise<void> {
    if (this.rl !== null) {
      this.rl.close();
      this.rl = null;
    }
  }
}
