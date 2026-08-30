      /**
       * **플러그인 뷰** — 목록 + 네 동작 + 요구 권한 (2026-08-28).
       *
       * ★자리를 nav 1급 목적지로 잡은 이유(정태님: *"플러그인 메인메뉴를 하나 따로 두는 게
       *  낫겠는데"*): 인벤토리는 *"무엇이 있나"* 를 보는 **읽기 전용** 자리인데, 플러그인엔
       *  **동작이 넷**(설치·제거·켜기·끄기)이고 보여줄 것도 많다(출처·버전·요구 권한·꽂힌
       *  capability). 성격이 다르다.
       *  ★앞서 「변경 이력」을 설정에 넣으며 *"새 네비 0"* 을 지킨 것과 모순이 아니다 —
       *   그건 **읽기 전용 한 덩어리**라서 맞았고, 여기는 반대다.
       *
       * ★**판단은 서버에 있다.** 이 파일은 `/api/plugins` 가 주는 것을 그리고, 누르면
       *  `/api/plugins/action` 을 부를 뿐이다 — 무엇이 켜져 있나·뺄 수 있나를 여기서 다시
       *  계산하지 않는다(가장자리는 판단하지 않는다).
       */
      const pluginsState = { items: [], meta: {}, busy: "" };
      /**
       * 플러그인 문구 — **그 플러그인 카탈로그만** 본다(코어 테이블로 안 넘어간다).
       *
       * ★넘어가면 경계가 무너진다: 플러그인이 `common.cancel` 같은 키를 쓰면 우리 문구가
       *  조용히 잡히고, 나중에 우리가 그걸 고치면 남의 설정 이름이 같이 바뀐다. 없으면
       *  키가 그대로 보이는데, 그건 실패지만 **보이는 실패**다(위젯 호스트와 같은 규칙).
       */
      const pluginCatalogs = new Map();
      const pluginText = (plugin, key) => {
        if (!key) return "";
        const c = pluginCatalogs.get(plugin);
        return c && typeof c[key] === "string" ? c[key] : "";
      };
      const loadPluginCatalog = async (plugin) => {
        if (pluginCatalogs.has(plugin)) return;
        pluginCatalogs.set(plugin, {}); // 한 번만 시도한다.
        const loc = (window.__TIGU_I18N__ && window.__TIGU_I18N__.locale) || "ko";
        try {
          const r = await fetch(
            "/plugin-asset/" + encodeURIComponent(plugin) + "/locales/" + encodeURIComponent(loc) + ".json",
          );
          if (r.ok) pluginCatalogs.set(plugin, await r.json());
        } catch {
          /* 카탈로그는 덤이다 — 없으면 키가 보인다 */
        }
      };

      const fetchPlugins = async () => {
        try {
          const r = await fetch("/api/plugins", { cache: "no-store" });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const d = await r.json();
          pluginsState.items = Array.isArray(d.items) ? d.items : [];
          pluginsState.meta = d;
          // 설정 행이 있는 것만 문구를 데려온다(없으면 요청 0).
          await Promise.all(
            pluginsState.items
              .filter((p) => Array.isArray(p.settings) && p.settings.length > 0)
              .map((p) => loadPluginCatalog(p.name)),
          );
          return true;
        } catch {
          pluginsState.items = [];
          pluginsState.meta = {};
          return false;
        }
      };

      /**
   * 선언을 **내 언어의 한 줄**로. 서버가 준 데이터(`needsFacts`)를 카탈로그로 옮긴다.
   *
   * ★자리표시자 이름은 카탈로그와 짝이다(`{hosts}`·`{slots}`) — 회귀
   *  `i18n-placeholders-match-callsites` 가 호출부까지 대조하므로 여기서 틀리면 운다.
   */
  const needsText = (p) => {
    const facts = p && p.needsFacts;
    if (!Array.isArray(facts) || facts.length === 0) return (p && p.needs) || "";
    // ★키를 **리터럴로** 적는다 — `"plugins.need." + f.kind` 로 조립하면 회귀
    //  `i18n-keys-complete` 가 키를 못 보고, 오타 하나가 사용자 화면에 키 문자열로
    //  뜬다(실제로 이 검사가 잡았다). 서버가 모르는 kind 를 보내면 빈 칸이 아니라
    //  **kind 이름**을 보여준다 — 모르는 것을 없는 것처럼 감추지 않는다.
    const line = (f) =>
      f.kind === "network"
        ? i18n("plugins.need.network", { hosts: f.value || "" })
        : f.kind === "ui"
          ? i18n("plugins.need.ui", { slots: f.value || "" })
          : f.kind === "networkUnknown"
            ? i18n("plugins.need.networkUnknown")
            : f.kind === "outbound"
              ? i18n("plugins.need.outbound")
              : f.kind === "llm"
                ? i18n("plugins.need.llm")
                : String(f.kind);
    return facts.map(line).join(" · ");
  };

  /**
   * **끄기 전에 물어야 하는가** — 켜는 건 안 묻고, 끄는 것만, 그것도 자기참조일 때만.
   *
   * ★인라인 조건이던 것을 이름으로 꺼냈다 (2026-08-30, 적대 검토 B-G1). 검사가 소스만
   *  볼 수 있어서 **극성 반전**(끌 때가 아니라 켤 때 묻기)이 안 잡혔다 — 사고 그 자체가
   *  복원되는데 그물은 초록이었다. 이름이 있으면 회귀가 **불러서** 네 조합을 다 밟는다.
   */
  const needsDisableConfirm = (p) => p.enabled !== false && p.selfReferential === true;

  const pluginAction = async (action, name, extra) => {
        pluginsState.busy = name + ":" + action;
        renderPluginsView();
        try {
          const r = await fetch("/api/plugins/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, name, ...(extra || {}) }),
          });
          const d = await r.json().catch(() => ({}));
          // ★서버가 준 **키**로 화면 언어에 맞춰 그린다 (2026-08-30, 적대 검토 C조 C3).
          //  종전엔 `d.reason` 을 그대로 띄워서 영어 사용자가 토스트에서 한국어를 만났다 —
          //  0.43.2 가 "화면 언어대로 나옵니다" 라고 고친 바로 그 기능의 형제 경로였다.
          // ★해석됐을 때만 쓴다. `i18n` 은 없는 키면 **키 자체**를 돌려주므로, 카탈로그가
          //  아직 그 키를 모르면 `plugins.reason.…` 라는 글자가 뜬다 — 그건 한국어 문장보다
          //  나쁘다. 그래서 서버 문장이 마지막 폴백으로 남는다(여기서 문장을 지어내진 않는다).
          if (d.ok === false) {
            const t = d.reasonKey ? i18n(d.reasonKey, d.reasonArgs) : "";
            showToast(t && t !== d.reasonKey ? t : d.reason || i18n("plugins.failed"), "bad");
          }
          else if (action === "enable" || action === "install") {
            // ★코드 갱신은 재부팅이 필요하다 — 되는 척하지 않는다(ESM 캐시, 실측).
            showToast(
              needsText(d)
                ? i18n("plugins.installed", { needs: needsText(d) })
                : i18n("plugins.done"),
              "good",
            );
          } else showToast(i18n("plugins.done"), "good");
        } catch (e) {
          showToast(i18n("plugins.failed") + ": " + e.message, "bad");
        } finally {
          pluginsState.busy = "";
          await fetchPlugins();
          renderPluginsView();
        }
      };

      const buildPluginCard = (p) => {
        const card = document.createElement("div");
        card.className = "settings-row plugin-row";
        card.dataset.plugin = p.name;

        const meta = document.createElement("div");
        meta.className = "settings-meta";
        const name = document.createElement("div");
        name.className = "settings-name";
        name.textContent = p.name + (p.version ? " " + p.version : "");
        const src = document.createElement("span");
        src.className = "plugin-src " + (p.source === "home" ? "home" : "bundled");
        src.textContent = i18n(p.source === "home" ? "plugins.src.home" : "plugins.src.bundled");
        name.appendChild(src);
        // ★설명 — 서버가 문자열이나 **언어별 객체**를 준다. 고르는 건 화면 몫이다.
        //  현재 언어 → en → 첫 번째 순으로 떨어진다(빈손보다 낫다).
        const pickText = (v) => {
          if (typeof v === "string") return v;
          if (!v || typeof v !== "object") return "";
          const loc = (window.__TIGU_I18N__ && window.__TIGU_I18N__.locale) || "ko";
          return v[loc] || v.en || Object.values(v)[0] || "";
        };
        const about = pickText(p.meta && p.meta.description);
        if (about !== "") {
          const a = document.createElement("div");
          a.className = "settings-desc plugin-about";
          a.textContent = about;
          meta.appendChild(name);
          meta.appendChild(a);
        } else {
          meta.appendChild(name);
        }
        const desc = document.createElement("div");
        desc.className = "settings-desc";
        // ★요구 권한을 **내 언어로** 보여준다 (2026-08-30 구조 검토). 종전엔 서버가 만든
        //  한국어 문장(`p.needs`)을 그대로 박아서 **영어 사용자가 한국어를 봤다** — 하필
        //  `docs/security.md §2` 가 "설치 전에 여기서 읽으세요" 라고 가리키는 자리다.
        //  서버는 이제 데이터(`needsFacts`)도 보내고, 문장은 여기서 만든다.
        // ★`p.needs` 폴백을 남긴다 — 옛 데몬에 새 화면이 붙는 순간(업데이트 도중)이 있고,
        //  그때 빈 칸을 보여주느니 한국어라도 보여주는 게 낫다.
        desc.textContent =
          (needsText(p) || "") + (p.wired && p.wired.length ? " · " + p.wired.join(", ") : "");
        card.appendChild(meta);

        if (p.enabled === false) card.classList.add("off");
        const actions = document.createElement("div");
        actions.className = "plugin-actions";
        const busy = pluginsState.busy.startsWith(p.name + ":");
        // 끄기/켜기 — **번들에도 된다**(제거는 안 되지만 끄는 건 된다). 꺼진 것도 목록에
        // 남아야 다시 켤 수 있다(안 그러면 일방통행 문이다).
        //
        // ★단 **끌 수 없는 것은 토글을 아예 안 만든다** (2026-08-30, 적대 검토 C조 P1).
        //  종전엔 누구든 누를 수 있었고 이 문엔 서버 거절도 없어서 **브리지가 실제로
        //  꺼졌다**(재시작 전까지 대시보드 API 사망). 서버는 이제 거절하지만, 못 하는 걸
        //  할 수 있는 것처럼 보여주지 않는 게 먼저다 — 눌러보고서야 아는 건 답이 아니다.
        if (p.core !== true) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "settings-toggle" + (p.enabled === false ? "" : " on");
          toggle.textContent = i18n(p.enabled === false ? "plugins.enable" : "plugins.disable");
          toggle.disabled = busy;
          toggle.addEventListener("click", () => {
            // ★**끄면 이 화면이 사라지는 것은 확인을 받는다** (2026-08-30, 적대 검토 B-2).
            //  종전엔 여기만 확인이 없어서, 모듈 화면에선 경고가 뜨는 그 플러그인을 이
            //  화면에선 한 번 눌러 껐다 — 실측: 63,216바이트 → `000`, 그리고 설정에 굳어
            //  재시작해도 안 돌아온다(되돌릴 문이 이 화면 하나였다).
            //  ★목록을 여기 두지 않는다 — 서버가 매니페스트 선언을 읽어 보내준다.
            if (needsDisableConfirm(p)) {
              if (!window.confirm(i18n("modules.disable.confirm"))) return; // 취소 → no-op
            }
            void pluginAction(p.enabled === false ? "enable" : "disable", p.name);
          });
          actions.appendChild(toggle);
        }
        // 제거 — 홈에 깐 것만. 번들은 서버가 거절하지만, 애초에 안 보여주는 게 정직하다.
        if (p.source === "home") {
          const rm = document.createElement("button");
          rm.type = "button";
          rm.className = "settings-toggle danger";
          rm.textContent = i18n("plugins.remove");
          rm.disabled = busy;
          rm.addEventListener("click", () => {
            if (!window.confirm(i18n("plugins.removeConfirm", { name: p.name }))) return;
            void pluginAction("remove", p.name);
          });
          actions.appendChild(rm);
        }
        card.appendChild(actions);

        // ── 설정 — **선언에서 행을 만든다** (2026-08-28, §D.2) ──────────────────
        // ★여기엔 플러그인 이름이 하나도 안 나온다. `buildLocaleRow`·`buildThemeRow` 처럼
        //  손으로 쓰면 플러그인이 늘 때마다 이 파일을 고쳐야 하고, 그게 곧 드리프트다
        //  ([[feedback_hand_maintained_lists]]).
        // ★번역도 플러그인 것을 쓴다 — `labelKey` 는 그 플러그인 카탈로그의 키다.
        const specs = Array.isArray(p.settings) ? p.settings : [];
        if (specs.length > 0 && p.enabled !== false) {
          const box = document.createElement("div");
          box.className = "plugin-settings";
          for (const spec of specs) {
            const row = document.createElement("div");
            row.className = "plugin-setting";
            const label = document.createElement("span");
            label.className = "plugin-setting-label";
            label.textContent = pluginText(p.name, spec.labelKey) || spec.key;
            row.appendChild(label);

            if (spec.type === "secret") {
              // ★값을 절대 안 보여준다 — 있다/없다뿐이고, 넣는 자리는 홈 `.env` 다.
              const st = document.createElement("span");
              st.className = "plugin-setting-secret" + (spec.hasSecret ? " on" : "");
              st.textContent = i18n(spec.hasSecret ? "plugins.secret.set" : "plugins.secret.unset");
              row.appendChild(st);
            } else if (spec.type === "enum") {
              const sel = document.createElement("select");
              sel.className = "plugin-setting-input";
              for (const v of spec.values || []) {
                const o = document.createElement("option");
                o.value = v;
                o.textContent = pluginText(p.name, "settings." + spec.key + "." + v) || v;
                sel.appendChild(o);
              }
              sel.value = String(spec.value !== undefined ? spec.value : (spec.default ?? ""));
              sel.disabled = busy;
              sel.addEventListener("change", () =>
                void pluginAction("set-setting", p.name, { key: spec.key, value: sel.value }),
              );
              row.appendChild(sel);
            } else if (spec.type === "boolean") {
              const btn = document.createElement("button");
              btn.type = "button";
              const on = spec.value === true || (spec.value === undefined && spec.default === true);
              btn.className = "settings-toggle" + (on ? " on" : "");
              btn.textContent = i18n(on ? "common.on" : "common.off");
              btn.disabled = busy;
              btn.addEventListener("click", () =>
                void pluginAction("set-setting", p.name, { key: spec.key, value: !on }),
              );
              row.appendChild(btn);
            } else {
              const inp = document.createElement("input");
              inp.className = "plugin-setting-input";
              inp.type = spec.type === "number" ? "number" : "text";
              inp.value = String(spec.value !== undefined ? spec.value : (spec.default ?? ""));
              inp.disabled = busy;
              // ★`change` 다(입력 중이 아니라 **끝났을 때**) — 키 하나마다 쓰면 파일을
              //  글자 수만큼 다시 쓴다.
              inp.addEventListener("change", () => {
                const raw = inp.value.trim();
                const value =
                  spec.type === "number" ? (raw === "" ? null : Number(raw)) : raw === "" ? null : raw;
                if (spec.type === "number" && value !== null && !Number.isFinite(value)) {
                  showToast(i18n("plugins.badNumber"), "bad");
                  return;
                }
                void pluginAction("set-setting", p.name, { key: spec.key, value });
              });
              row.appendChild(inp);
            }
            box.appendChild(row);
          }
          card.appendChild(box);
        }
        return card;
      };

      const renderPluginsView = () => {
        const root = document.getElementById("detail-panel");
        if (!root || currentView !== "plugins") return; // 다른 뷰로 옮겼으면 그리지 않는다.
        root.innerHTML =
          '<div class="page-view"><div class="detail-head"><div class="detail-accent"></div>' +
          '<div class="detail-name"></div><div class="detail-sub"></div></div>' +
          '<div class="plugin-note"></div><div class="plugin-list"></div>' +
          '<div class="plugin-install"></div></div>';
        root.querySelector(".detail-name").textContent = i18n("nav.plugins");
        root.querySelector(".detail-sub").textContent = i18n("plugins.desc");
        // ★**되는 척하지 않는다** — 서버가 준 사실을 그대로 적는다(ESM 캐시 때문에 코드
        //  갱신은 재시작이 필요하고, 위젯·CSS 는 새로고침이면 된다).
        if (pluginsState.meta.codeReloadRequiresRestart === true) {
          root.querySelector(".plugin-note").textContent = i18n("plugins.reloadNote");
        }
        const list = root.querySelector(".plugin-list");
        if (pluginsState.items.length === 0) {
          const e = document.createElement("div");
          e.className = "empty";
          e.textContent = i18n("plugins.empty");
          list.appendChild(e);
        } else {
          for (const p of pluginsState.items) list.appendChild(buildPluginCard(p));
        }

        // 설치 — **이름만** 받는다. 폴더는 사용자가 이미 홈에 둔 것이고, 여기서 원격을
        // 받아오지 않는다(그건 격리 이후다).
        const inst = root.querySelector(".plugin-install");
        const row = document.createElement("div");
        row.className = "settings-row";
        const m2 = document.createElement("div");
        m2.className = "settings-meta";
        const n2 = document.createElement("div");
        n2.className = "settings-name";
        n2.textContent = i18n("plugins.install.head");
        const d2 = document.createElement("div");
        d2.className = "settings-desc";
        d2.textContent = i18n("plugins.install.desc");
        m2.appendChild(n2);
        m2.appendChild(d2);
        const input = document.createElement("input");
        input.type = "text";
        input.className = "plugin-install-input";
        input.placeholder = i18n("plugins.install.placeholder");
        const go = document.createElement("button");
        go.type = "button";
        go.className = "settings-toggle";
        go.textContent = i18n("plugins.install.btn");
        const submit = () => {
          const v = input.value.trim();
          if (v === "") return;
          void pluginAction("install", v);
        };
        go.addEventListener("click", submit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") submit();
        });
        row.appendChild(m2);
        row.appendChild(input);
        row.appendChild(go);
        inst.appendChild(row);
      };

      const showPlugins = async () => {
        setActiveNav("plugins");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.remove("show-capabilities");
        const root = document.getElementById("detail-panel");
        root.innerHTML = '<div class="page-view"><div class="empty"></div></div>';
        root.querySelector(".empty").textContent = i18n("common.loading");
        await fetchPlugins();
        renderPluginsView();
      };
