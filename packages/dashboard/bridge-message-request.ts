import http from "node:http";

/** 작업 완료를 기다리는 /messages 전용. 자동 재시도나 응답 대기 시간제한은 없다. */
export const requestBridgeMessage = (
  downstream: http.ServerResponse,
  url: string,
  token: string,
  body: string,
): Promise<{ status: number; contentType: string; text: string }> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let response: http.IncomingMessage | undefined;
    const finish = (error?: Error, value?: { status: number; contentType: string; text: string }) => {
      if (settled) return;
      settled = true;
      downstream.off("close", disconnected);
      if (error) {
        response?.destroy();
        request.destroy();
        reject(error);
      } else resolve(value!);
    };
    const disconnected = () => finish(new Error("dashboard client disconnected"));
    const request = http.request(url, {
      method: "POST",
      agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (incoming) => {
      response = incoming;
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", (error) => finish(error));
      incoming.on("aborted", () => finish(new Error("bridge response interrupted")));
      incoming.on("end", () => finish(undefined, {
        status: incoming.statusCode ?? 502,
        contentType: incoming.headers["content-type"] ?? "application/json; charset=utf-8",
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", (error) => finish(error));
    downstream.once("close", disconnected);
    if (downstream.destroyed) disconnected();
    else request.end(body);
  });
