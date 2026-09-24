import http from "node:http";
import { assertIsolated } from "./_framework.js";
assertIsolated();
process.env.HTTP_BRIDGE_TOKEN = "synthetic-bridge-stop";
const { default: HttpBridge } = await import(new URL("../../../plugins/http-bridge/index.ts", import.meta.url).href);
const bridge = new HttpBridge();
const events: string[] = [];
let accepted = 0, response: http.ServerResponse | undefined;
let arrived!: () => void;
const received = new Promise<void>(r => { arrived = r; });
const server = http.createServer((req, res) => {
  accepted++; req.resume(); response = res; arrived();
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
Object.assign(bridge, {
  server,
  channelHandler: () => {},
  bus: {},
  busUnsubscribe: () => events.push("unsubscribe"),
});
const port = (server.address() as import("node:net").AddressInfo).port;
let clientClosed = false;
const client = http.request(`http://127.0.0.1:${port}/messages`, { method: "POST" });
client.on("error", () => {});
client.on("close", () => { clientClosed = true; });
client.end('{}');
await received;
await new Promise(r => setTimeout(r, 50));
const remainedOpenBeforeStop = !clientClosed && !response?.destroyed;
const watchdog = setTimeout(() => { console.error("stop watchdog"); process.exit(2); }, 2000);
const signal = process.argv[2] === "SIGINT" ? "SIGINT" : "SIGTERM";
// 종속 모듈의 전역 종료 훅은 이 격리 프로브의 종료 체인을 대신하지 않는다.
process.removeAllListeners(signal);
process.once(signal, () => {
  void (async () => {
    events.push(signal);
    await bridge.stop();
    events.push("next-service-stop");
    await bridge.stop(); // 중복 종료도 대기하지 않는다.
    await new Promise(r => setTimeout(r, 30));
    let refused = false;
    const probe = http.get(`http://127.0.0.1:${port}/`);
    probe.on("error", () => { refused = true; });
    await new Promise(r => probe.on("close", r));
    clearTimeout(watchdog);
    console.log("BRIDGE_STOP_RESULT=" + JSON.stringify({ signal, signalDelivery: process.platform === "win32" ? "event" : "os", events, remainedOpenBeforeStop, clientClosed, refused, accepted, cleared: bridge.server === null && bridge.channelHandler === null && bridge.bus === null }));
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
});
if (process.platform === "win32") process.emit(signal);
else process.kill(process.pid, signal);
