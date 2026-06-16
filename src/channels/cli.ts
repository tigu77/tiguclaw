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

    rl.on("line", (line) => {
      const text = line.trim();
      if (text.length === 0) {
        rl.prompt();
        return;
      }
      const msg: IncomingMessage = {
        channel: "cli",
        channelUserId: "local",
        threadKey: "cli:local",
        text,
        receivedAt: Date.now(),
        reply,
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
