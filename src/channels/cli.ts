import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Channel, IncomingMessage, MessageHandler } from "./types.js";

export class CliChannel implements Channel {
  readonly name = "cli" as const;
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
      const msg: IncomingMessage = {
        channel: "cli",
        channelUserId: "local",
        threadKey: "cli:local",
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
