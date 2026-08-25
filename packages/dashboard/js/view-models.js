      /**
       * 프로파일 배지 색 — `settings.json` 의 `models.profiles.<name>.color`(`#rrggbb`).
       *
       * ★손목록을 **없애려고** 만들었다 (2026-08-24 사용자 요청). 종전엔 색이 CSS 에
       *  `[data-tier="low"|"mid"|"high"]` **세 이름만** 적혀 있어서, 사용자가 만든 프로파일
       *  (`gpt-high` 등)은 전부 회색으로 떨어졌다([[feedback_hand_maintained_lists]]).
       *  이제 색은 프로파일이 자기가 들고 오고, CSS 세 줄은 **미지정일 때의 기본값**으로만 남는다.
       * ★형식 검증은 서버 경계(`isBadgeColor`)가 한다 — 여기선 한 번 더 확인만(값이 CSS 로
       *  나가므로, 경계를 못 믿는 게 아니라 **주입 지점에서 한 번 더** 막는 게 싸다).
       */
      const HEX6 = /^#[0-9a-fA-F]{6}$/;
      const profileColor = (prof) =>
        prof && typeof prof.color === "string" && HEX6.test(prof.color.trim())
          ? prof.color.trim().toLowerCase()
          : "";
      /** `#rrggbb` → `rgba(r,g,b,a)` — 배지 배경·테두리에 옅게 깔려고. */
      const hexRgba = (hex, a) => {
        const n = parseInt(hex.slice(1), 16);
        return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
      };
      /** 프로파일 색을 배지 엘리먼트에 입힌다(색이 없으면 아무것도 안 한다 = CSS 기본). */
      const paintProfileBadge = (el, color) => {
        if (!el || color === "") return;
        el.style.color = color;
        el.style.background = hexRgba(color, 0.16);
        el.style.borderColor = hexRgba(color, 0.4);
      };
      /**
       * 프로파일 **이름** → 색 — 잡·에이전트 티어 배지가 쓴다.
       * 정의점은 서버가 준 목록(`modelProfilesCache`)이고, 여기선 조회만 한다 —
       * 색 표를 화면 쪽에 또 만들면 그게 두 번째 손목록이 된다.
       */
      const profileColorByName = (name) => {
        const list = (modelProfilesCache && modelProfilesCache.profiles) || [];
        const hit = list.find((p) => p && p.name === name);
        return profileColor(hit);
      };
      const renderModelProfiles = (data) => {
        modelProfilesCache = data;
        const root = document.getElementById("models");
        const navCount = document.getElementById("nav-model-count");
        const profiles = (data && data.profiles) || [];
        if (navCount) navCount.textContent = String(profiles.length);
        if (!root) return;
        root.innerHTML = "";
        if (profiles.length === 0) {
          const e = document.createElement("div");
          e.className = "empty";
          e.textContent = i18n("models.profiles.empty");
          root.appendChild(e);
          return;
        }
        for (const prof of profiles) {
          const card = document.createElement("div");
          card.className = "model-card" + (prof.isDefault ? " is-default" : "");
          const head = document.createElement("div");
          head.className = "model-card-head";
          const name = document.createElement("span");
          name.className = "model-card-name";
          name.textContent = prof.name;
          // ★프로파일이 색을 들고 왔으면 이름 자체를 그 색으로 — 잡 카드 티어 배지와 같은 색이
          //  되어 "어느 프로파일로 돈 작업인가" 가 두 화면에서 같은 신호로 보인다.
          { const c = profileColor(prof); if (c !== "") { name.style.color = c; card.style.borderLeft = "3px solid " + hexRgba(c, 0.55); } }
          head.appendChild(name);
          // ★배지를 **여기서 보여준다** (2026-08-25 사용자: "모델프로필에서 배지를 표시해주면
          //  되지 않을까"). 색은 화면을 보면서 고르는 것이라, 잡 카드에 실제로 뜰 모양을 그대로
          //  옆에 놓고 그 자리에서 고르게 한다 — 저장하고 다른 화면 가서 확인하는 왕복을 없앤다.
          //  배지 클래스는 잡 카드와 **같은 것**을 쓴다(`bg-job-tier`) — 미리보기가 실물과
          //  다르면 그건 미리보기가 아니다.
          const swatch = document.createElement("span");
          swatch.className = "bg-job-tier model-color-preview";
          swatch.textContent = prof.name;
          paintProfileBadge(swatch, profileColor(prof));
          head.appendChild(swatch);

          const picker = document.createElement("input");
          picker.type = "color";
          picker.className = "model-color-input";
          picker.value = profileColor(prof) || "#9aa7b7";
          picker.title = i18n("models.color.hint");
          const saveColor = async (color) => {
            picker.disabled = true;
            try {
              const r = await fetch("/api/set-profile-color", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: prof.name, color }),
              });
              const data = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
              showToast(i18n(color === null ? "models.color.resetDone" : "models.color.changed", { name: prof.name }), "good");
              await fetchModelProfiles(); // 이름색·좌측선·배지까지 한 번에 재렌더.
            } catch (e) {
              showToast(i18n("models.color.failed", { err: e.message }), "bad");
              picker.disabled = false;
            }
          };
          // `input` 은 드래그 중 초당 수십 번 온다 — 저장은 `change`(고르기 끝) 한 번만.
          // 미리보기는 `input` 으로 즉시(저장 없이) — 고르는 동안 결과가 보여야 한다.
          picker.addEventListener("input", () => paintProfileBadge(swatch, picker.value));
          picker.addEventListener("change", () => void saveColor(picker.value));
          head.appendChild(picker);

          if (profileColor(prof) !== "") {
            const reset = document.createElement("button");
            reset.type = "button";
            reset.className = "model-color-reset";
            reset.textContent = i18n("models.color.reset");
            reset.title = i18n("models.color.resetTitle");
            reset.addEventListener("click", () => void saveColor(null));
            head.appendChild(reset);
          }
          if (prof.isDefault) {
            const badge = document.createElement("span");
            badge.className = "model-default-badge";
            badge.textContent = "default";
            head.appendChild(badge);
          } else {
            // 기본이 아닌 프로파일 → "기본으로 설정" 버튼(models.default 포인터 이동).
            const setBtn = document.createElement("button");
            setBtn.type = "button";
            setBtn.className = "model-set-default";
            setBtn.textContent = i18n("models.setDefault");
            setBtn.addEventListener("click", async () => {
              setBtn.disabled = true;
              try {
                const r = await fetch("/api/set-default-profile", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: prof.name }),
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
                showToast(i18n("models.default.set", { name: prof.name }), "good");
                await fetchModelProfiles(); // 배지 이동 반영(재렌더).
              } catch (e) {
                showToast(i18n("models.default.failed", { err: e.message }), "bad");
                setBtn.disabled = false;
              }
            });
            head.appendChild(setBtn);
          }
          card.appendChild(head);
          if (prof.description) {
            const desc = document.createElement("div");
            desc.className = "model-card-desc";
            desc.textContent = prof.description;
            card.appendChild(desc);
          }
          const pool = document.createElement("div");
          pool.className = "model-pool";
          const plabel = document.createElement("span");
          plabel.className = "model-pool-label";
          plabel.textContent = i18n("models.pool.label");
          pool.appendChild(plabel);
          // ★풀 원소는 문자열 또는 `{spec, reasoning}` 이다 (2026-08-24). 서버가 정규화해
          //  보내지만, 옛 배포본과 섞여도 안 깨지게 여기서도 둘 다 받는다(경계 관용).
          const entries = (prof.pool || [])
            .map((s) => (typeof s === "string" ? { spec: s.trim() } : {
              spec: String((s && s.spec) || "").trim(),
              reasoning: s && typeof s.reasoning === "string" ? s.reasoning : undefined,
            }))
            .filter((e) => e.spec !== "");
          if (entries.length === 0) {
            const empty = document.createElement("span");
            empty.className = "model-pool-empty";
            empty.textContent = i18n("models.pool.empty");
            pool.appendChild(empty);
          } else {
            entries.forEach((e, i) => {
              if (i > 0) {
                const arrow = document.createElement("span");
                arrow.className = "model-pool-arrow";
                arrow.textContent = "→";
                pool.appendChild(arrow);
              }
              const chip = document.createElement("span");
              chip.className = "model-spec";
              chip.textContent = e.spec;
              pool.appendChild(chip);
              // ★강도를 **덮은 것만** 칩 옆에 붙인다 (principle-check 가 조건으로 건 가시성).
              //  층이 셋(풀 원소 > models.reasoning > 카탈로그)이라 어디서 온 값인지 안 보이면,
              //  전역을 바꿔도 안 먹는 이유를 알 수 없다. 안 덮었으면 아무것도 안 그린다 —
              //  카탈로그 기본을 여기서 지어내면 그게 거짓 정보다(우리는 그 값을 모른다).
              if (e.reasoning !== undefined && e.reasoning !== "") {
                const r = document.createElement("span");
                r.className = "model-spec-reasoning";
                r.textContent = i18n("models.effort.badge", { v: e.reasoning });
                r.title =
                  i18n("models.effort.hint");
                pool.appendChild(r);
              }
            });
          }
          card.appendChild(pool);
          if (prof.fallback) {
            const fb = document.createElement("div");
            fb.className = "model-fallback";
            fb.innerHTML = escHtml(i18n("models.fallback.label")) + " <code></code>";
            fb.querySelector("code").textContent = prof.fallback;
            card.appendChild(fb);
          }
          root.appendChild(card);
        }
      };

      const fetchModelProfiles = async () => {
        try {
          const r = await fetch("/api/model-profiles");
          if (!r.ok) throw new Error("HTTP " + r.status);
          renderModelProfiles(await r.json());
        } catch (e) {
          const root = document.getElementById("models");
          if (root) root.innerHTML =
            '<div class="empty" style="font-size:11px;padding:10px">' +
            escHtml(i18n("models.profiles.loadFailed", { err: e.message })) + "</div>";
        }
      };

      const showModels = () => {
        setActiveNav("models");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.remove("show-capabilities");
        const root = document.getElementById("detail-panel");
        root.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "page-view";
        // ★카탈로그 값을 **innerHTML 로 넣지 않는다**. 언어 파일은 사용자가 받아서 홈에 놓는
        //  데이터라, 그대로 넣으면 번역 파일 하나가 대시보드 XSS 벡터가 된다(같은 오리진의
        //  /api/messages = 비서에게 임의 지시). 문구는 텍스트로만 넣고, 안에 들어갈 태그는
        //  자리표시자를 기준으로 잘라 **DOM 으로 조립**한다.
        wrap.innerHTML =
          '<div class="detail-head"><div class="detail-accent active"></div>' +
          '<div class="detail-name"></div><span class="detail-kind"></span></div>' +
          '<p class="developer-copy"></p>' +
          '<div id="models" class="models-shell"><div class="empty"></div></div>';
        wrap.querySelector(".detail-name").textContent = i18n("models.page.title");
        wrap.querySelector(".detail-kind").textContent = i18n("models.page.kind");
        wrap.querySelector(".models-shell .empty").textContent = i18n("common.loading");
        {
          const para = wrap.querySelector(".developer-copy");
          const [head, tail] = i18n("models.page.desc").split("{code}");
          para.appendChild(document.createTextNode(head));
          if (tail !== undefined) {
            const codeEl = document.createElement("code");
            codeEl.textContent = "models.profiles";
            para.appendChild(codeEl);
            para.appendChild(document.createTextNode(tail));
          }
        }
        root.appendChild(wrap);
        if (modelProfilesCache) renderModelProfiles(modelProfilesCache);
      };

      // ── 설정 뷰 (2026-08-10) ────────────────────────────────────────────────
      // 항목 **하나**로 시작한다. 미래 설정을 위한 틀을 미리 세우지 않는다 — 항목이 늘 때
      // 늘리는 게 이 레포 방식이고, 지금 프레임워크부터 만들면 그게 곧 "미래 가능성 위해
      // 만든 구조" 다. 값은 서버(settings.json)에 있고 저장 즉시 다음 턴부터 반영된다.
      const renderSettingsRow = (root, enabled) => {
        root.innerHTML = "";
        const page = document.createElement("div");
        page.className = "page-view";
        page.innerHTML =
          '<div class="detail-head"><div class="detail-accent"></div>' +
          '<div class="detail-name"></div></div>';
        page.querySelector(".detail-name").textContent = i18n("nav.settings");
        const row = document.createElement("div");
        row.className = "settings-row";
        const meta = document.createElement("div");
        meta.className = "settings-meta";
        const name = document.createElement("div");
        name.className = "settings-name";
        name.textContent = i18n("models.suggest.head");
        const desc = document.createElement("div");
        desc.className = "settings-desc";
        desc.textContent =
          i18n("models.suggest.hint");
        meta.appendChild(name);
        meta.appendChild(desc);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-toggle" + (enabled ? " on" : "");
        btn.textContent = enabled ? i18n("common.on") : i18n("common.off");
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const next = !enabled;
          try {
            const r = await fetch("/api/set-suggestion", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: next }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
            showToast(i18n("models.suggest.toggled", { state: next ? i18n("common.on") : i18n("common.off") }), "good");
            renderSettingsRow(root, next); // 서버가 확인해 준 값으로 다시 그린다.
          } catch (e) {
            showToast(i18n("models.settings.saveFailed", { err: e.message }), "bad");
            btn.disabled = false;
          }
        });
        row.appendChild(meta);
        row.appendChild(btn);
        page.appendChild(row);
        page.appendChild(buildLocaleRow());
        page.appendChild(buildLogRow());
        page.appendChild(buildChangelogRow());
        root.appendChild(page);
      };

      /**
       * 「화면 언어」 항목 (2026-08-25 사용자: "언어선택은 무조건 있어야지").
       *
       * ★목록은 **서버가 주입한 카탈로그에서 읽는다**(`__TIGU_I18N__.available`). 조회
       *  엔드포인트를 새로 만들면 "무슨 언어가 있나" 의 정본이 둘이 되는데, 화면은 이미 그
       *  값을 받고 있다. 그리고 그 목록의 정본은 **파일**이다 — `<home>/locales/*.json` 을
       *  놓으면 여기 저절로 나타난다(코드 변경 0).
       * ★이름은 `Intl.DisplayNames` 가 만든다 — 언어 이름표를 손으로 관리하면 언어를 늘릴
       *  때마다 코드를 고쳐야 하고, 그러면 "파일 하나로 추가" 가 거짓이 된다.
       * ★고르면 **새로고침**한다. 카탈로그는 서빙 시점에 index.html 로 주입되므로(첫 렌더가
       *  깜빡이지 않게 한 선택), 이미 그려진 화면을 부분 갱신하는 길은 없다. 숨기지 않고
       *  그렇게 말한다.
       */
      const buildLocaleRow = () => {
        const row = document.createElement("div");
        row.className = "settings-row";
        const meta = document.createElement("div");
        meta.className = "settings-meta";
        const name = document.createElement("div");
        name.className = "settings-name";
        name.textContent = i18n("models.locale.head");
        const desc = document.createElement("div");
        desc.className = "settings-desc";
        meta.appendChild(name);
        meta.appendChild(desc);

        const cur = (window.__TIGU_I18N__ && window.__TIGU_I18N__.locale) || "ko";
        const list = (window.__TIGU_I18N__ && window.__TIGU_I18N__.available) || [cur];
        desc.textContent = i18n("models.locale.hint")
          .replace("{n}", String(list.length));

        const sel = document.createElement("select");
        sel.className = "chat-model-select";
        sel.title = i18n("models.locale.head");
        for (const code of list) {
          const o = document.createElement("option");
          o.value = code;
          o.textContent = localeDisplayName(code, cur);
          if (code === cur) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener("change", async () => {
          const next = sel.value;
          if (next === cur) return;
          sel.disabled = true;
          try {
            const r = await fetch("/api/set-locale", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ locale: next }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
            showToast(i18n("models.locale.changing"), "good");
            setTimeout(() => window.location.reload(), 600);
          } catch (e) {
            showToast(i18n("models.locale.changeFailed", { err: e.message }), "bad");
            sel.value = cur;
            sel.disabled = false;
          }
        });

        row.appendChild(meta);
        row.appendChild(sel);
        return row;
      };

      /**
       * 언어 코드 → 사람이 읽는 이름. **그 언어 자신의 이름**을 우선한다("English",
       * "한국어") — 지금 화면 언어를 못 읽는 사람이 자기 언어를 찾는 자리이기 때문이다.
       * 현재 언어로 부르는 이름이 다르면 괄호로 덧붙인다("English (영어)").
       */
      const localeDisplayName = (code, current) => {
        const of = (inLocale) => {
          try {
            const n = new Intl.DisplayNames([inLocale], { type: "language" }).of(code);
            return typeof n === "string" && n !== code ? n : "";
          } catch { return ""; }
        };
        const own = of(code);
        const here = of(current);
        if (own === "") return here === "" ? code : here;
        return here === "" || here === own ? own : own + " (" + here + ")";
      };

      /**
       * 「오늘 로그」 항목 — **크기·마지막 기록을 보여준 뒤** 비우기를 제공한다.
       *
       * ★볼 수 없는 것을 지우는 버튼은 만들지 않는다. 대시보드엔 로그 뷰가 없으므로,
       *  최소한 "얼마나 쌓였고 언제 마지막으로 찍혔나"는 같은 자리에서 답해야 한다
       *  (그게 대개 비우려는 이유이기도 하다 — 용량).
       * ★버튼은 **비우기(truncate)** 다. 지우기·옮기기는 제공하지 않는다 — 손으로 옮기면
       *  데몬이 옛 파일에 계속 써서 로그가 조용히 사라지는데, 그 사고 때문에 만든 기능이
       *  같은 일을 하면 안 된다.
       */
      const buildLogRow = () => {
        const row = document.createElement("div");
        row.className = "settings-row";
        const meta = document.createElement("div");
        meta.className = "settings-meta";
        const name = document.createElement("div");
        name.className = "settings-name";
        name.textContent = i18n("models.log.head");
        const desc = document.createElement("div");
        desc.className = "settings-desc";
        desc.textContent = i18n("common.loading");
        meta.appendChild(name);
        meta.appendChild(desc);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-toggle";
        btn.textContent = i18n("common.clear");
        btn.disabled = true;

        const fmtBytes = (n) =>
          n < 1024 ? n + "B"
          : n < 1024 * 1024 ? (n / 1024).toFixed(1) + "KB"
          : (n / 1024 / 1024).toFixed(1) + "MB";

        const paint = (s) => {
          if (!s || s.exists !== true) {
            desc.textContent = i18n("models.log.empty");
            btn.disabled = true;
            return;
          }
          const ago = s.lastWriteTs ? fmtAgo(s.lastWriteTs) : "";
          const others = s.otherDays > 0 ? i18n("models.log.otherDays", { n: s.otherDays }) : "";
          const last = ago ? i18n("models.log.lastWrite", { ago }) : "";
          desc.textContent = i18n("models.log.desc", { size: fmtBytes(s.bytes), last, others });
          btn.disabled = s.bytes === 0;
        };

        const load = async () => {
          try {
            const r = await fetch("/api/log-status");
            paint(r.ok ? await r.json() : null);
          } catch {
            desc.textContent = i18n("models.log.loadFailed");
            btn.disabled = true;
          }
        };

        btn.addEventListener("click", async () => {
          if (!window.confirm(i18n("models.log.clearConfirm"))) return;
          btn.disabled = true;
          try {
            const r = await fetch("/api/log-clear", { method: "POST" });
            const d = await r.json().catch(() => ({}));
            if (r.ok && d.ok === true) {
              showToast(i18n("models.log.cleared", { size: fmtBytes(d.clearedBytes || 0) }), "good");
              paint(d.status); // 서버가 준 사후 상태로 그린다(스스로 증명한 값).
            } else {
              showToast(i18n("models.log.clearFailed", { err: d.error || "HTTP " + r.status }), "bad");
              await load();
            }
          } catch (e) {
            showToast(i18n("models.log.clearFailed", { err: e.message }), "bad");
            await load();
          }
        });

        row.appendChild(meta);
        row.appendChild(btn);
        load();
        return row;
      };

      const showSettings = async () => {
        setActiveNav("settings");
        setChatPanel("chat");
        document.getElementById("workbench").classList.remove("show-providers");
        document.getElementById("workbench").classList.remove("show-capabilities");
        const root = document.getElementById("detail-panel");
        root.innerHTML =
          '<div class="page-view"><div class="detail-head"><div class="detail-accent"></div>' +
          '<div class="detail-name"></div></div><div class="empty"></div></div>';
        root.querySelector(".detail-name").textContent = i18n("nav.settings");
        root.querySelector(".empty").textContent = i18n("common.loading");
        let enabled = false;
        try {
          const r = await fetch("/api/suggestion");
          if (r.ok) {
            const d = await r.json();
            enabled = d && d.enabled === true;
          }
        } catch { /* 조회 실패 = 꺼짐으로 그린다(값은 서버가 정본) */ }
        renderSettingsRow(root, enabled);
      };

      // ── 변경 이력 (2026-08-24 사용자 요청: "릴리즈 노트를 대시보드에서 확인") ──────
      //  ★자리를 여기로 정한 이유(principle-check Q0): `#detail-panel` 은 자유 패널이 아니라
      //   **nav 목적지 본체**다(뷰별 `currentView` 전환). 홈에서 그걸 가로채면 다른 여덟 뷰와
      //   규칙이 갈리고, 새 목적지를 만들면 "새 네비 0" 이 거짓이 된다. `설정` 은 이미 nav 에
      //   있고 주제("이 설치본에 대한 것")도 맞다 — 진짜로 새 화면이 0이다.
      //  ★**버튼 뒤에 둔다**(사용자 지정). 설정을 열 때마다 140KB·153섹션을 그리던 것을
      //   누를 때만 그린다 — 설정의 본업은 토글이고, 릴리스 노트는 찾아서 보는 것이다.
      //   덤으로 안 누르면 fetch 도 0이다(설정 진입 비용이 원래대로 돌아온다).
      const buildChangelogRow = () => {
        const row = document.createElement("div");
        row.className = "settings-row";
        const meta = document.createElement("div");
        meta.className = "settings-meta";
        const name = document.createElement("div");
        name.className = "settings-name";
        name.textContent = i18n("models.changelog.head");
        const desc = document.createElement("div");
        desc.className = "settings-desc";
        desc.textContent = i18n("models.changelog.desc");
        meta.appendChild(name);
        meta.appendChild(desc);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-toggle";
        btn.textContent = i18n("common.view");
        row.appendChild(meta);
        row.appendChild(btn);

        // 본문은 행 **아래**에 붙는다 — 행 자체가 열림 상태를 들고 있으므로 새 화면이 없다.
        const wrap = document.createElement("div");
        wrap.className = "changelog-body";
        wrap.hidden = true;
        const body = document.createElement("div");
        body.className = "md";
        wrap.appendChild(body);

        let loaded = false;
        btn.addEventListener("click", async () => {
          if (!wrap.hidden) { // 접기
            wrap.hidden = true;
            btn.textContent = i18n("common.view");
            btn.classList.remove("on");
            return;
          }
          wrap.hidden = false;
          btn.textContent = i18n("common.collapse");
          btn.classList.add("on");
          if (loaded) return; // 한 번만 받는다(파일은 재시작 전까지 안 바뀐다).
          body.className = "empty";
          body.textContent = i18n("common.loading");
          let md = "";
          try {
            const r = await fetch("/api/changelog");
            if (r.ok) md = String((await r.json()).markdown || "");
          } catch { /* 미도달 — 아래 안내로 떨어진다 */ }
          // ★없으면 **없다고 말한다** — 빈 화면으로 두면 "로딩 중" 과 구분이 안 된다.
          if (md.trim() === "") {
            body.textContent = i18n("models.changelog.missing");
            return; // loaded 를 안 세운다 — 다시 눌러 재시도할 수 있게.
          }
          loaded = true;
          body.className = "md";
          if (typeof renderMarkdown === "function") body.innerHTML = renderMarkdown(md);
          else body.textContent = md; // 렌더러 부재 시 평문 폴백(내용은 잃지 않는다).
        });

        const frag = document.createDocumentFragment();
        frag.appendChild(row);
        frag.appendChild(wrap);
        return frag;
      };

      // ── 에이전트 뷰(왼쪽 nav 1급 destination) ──────────────────────────────
      // 오른쪽 백그라운드 드로어와 "동일한" jobCards 데이터를 읽어 크게 렌더한다(별도 데이터
      // 모델·엔드포인트 없음). 진행 중/전체 토글·경과시간·마지막 스텝 로직 재사용. worker.*
      // lifecycle / llm.activity(worker:|agent:) 가 들어올 때마다 renderAgentsView 가 (뷰가
