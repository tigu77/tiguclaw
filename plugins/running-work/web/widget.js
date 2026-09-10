/**
 * Running Work 위젯 — 플러그인이 그린다 (2026-08-28, 증분 5).
 *
 * ★**특권이 없다.** 코어 데이터를 그리지만 등록·자산·수명이 전부 날씨·지도와 같은 길이다.
 * ★순서·재연결·스냅샷을 **모른다** — `ctx.resource(...).subscribe` 가 값만 준다.
 * ★색을 쓰지 않고(토큰), 문장을 서버에서 받지 않는다(`ctx.t`).
 */
(() => {
  if (!document.getElementById("rw-css")) {
    const l = document.createElement("link");
    l.id = "rw-css"; l.rel = "stylesheet"; l.href = "/plugin-asset/running-work/widget.css";
    document.head.appendChild(l);
  }
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  // ★아이콘도 **자기 카탈로그**에서 (2026-09-10). `ctx.t` 는 플러그인 것만 보므로 코어 키를
  //  못 읽는다 — 그건 결함이 아니라 격리다([[feedback_external_things_own_their_unit]]).
  //  대신 이 플러그인은 **코어 데이터를 그리는 1차 번들**이라 값은 코어와 맞춰 둔다.
  const ICON = (ctx, kind) => {
    const v = ctx.t("icon." + kind);
    return v && v !== "icon." + kind ? v : (kind === "agent" ? "🤖" : "🎖️");
  };

  window.tiguWidgets.register("running-work/live", {
    mount(root, _data, ctx) {
      const box = el("div", "rw");
      root.appendChild(box);
      const draw = (jobs) => {
        box.replaceChildren();
        const running = (Array.isArray(jobs) ? jobs : []).filter(
          (j) => j && j.status === "running",
        );
        if (running.length === 0) {
          // ★**없으면 없다고 말한다** — 빈 상자는 "고장인가" 로 읽힌다.
          box.appendChild(el("div", "rw-idle", ctx.t("idle")));
          return;
        }
        for (const j of running) {
          const row = el("div", "rw-row");
          row.appendChild(el("span", "rw-ic", ICON(ctx, j.kind === "agent" ? "agent" : "worker")));
          row.appendChild(el("span", "rw-label", j.label || j.agentName || ctx.t("unnamed")));
          if (typeof j.startedAt === "number") {
            const mins = Math.max(0, Math.round((Date.now() - j.startedAt) / 60000));
            row.appendChild(el("span", "rw-since", ctx.t("since", { n: mins })));
          }
          box.appendChild(row);
        }
      };
      draw(null);
      // 해지는 코어가 한다(`ctx.onDispose` 에 걸린다) — 위젯이 잊어도 안 샌다.
      ctx.resource("running-work").subscribe(draw);
    },
    unmount(root) {
      root.replaceChildren();
    },
  });
})();
