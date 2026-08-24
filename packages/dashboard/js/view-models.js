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
          e.textContent = "정의된 모델 프로파일이 없습니다 (settings.json 의 models.profiles 비어 있음).";
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
            setBtn.textContent = "기본으로 설정";
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
                showToast("기본 프로파일: " + prof.name, "good");
                await fetchModelProfiles(); // 배지 이동 반영(재렌더).
              } catch (e) {
                showToast("기본 설정 실패: " + e.message, "bad");
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
          plabel.textContent = "풀";
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
            empty.textContent = "(빈 풀 — 어댑터 디폴트로 강등)";
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
                r.textContent = "강도 " + e.reasoning;
                r.title =
                  "이 프로파일에서만 적용되는 추론 강도 — 전역 models.reasoning 보다 우선합니다.";
                pool.appendChild(r);
              }
            });
          }
          card.appendChild(pool);
          if (prof.fallback) {
            const fb = document.createElement("div");
            fb.className = "model-fallback";
            fb.innerHTML = "폴백 프로파일: <code></code>";
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
            '<div class="empty" style="font-size:11px;padding:10px">모델 프로파일 불러오기 실패: ' + escHtml(e.message) + "</div>";
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
        wrap.innerHTML = '<div class="detail-head"><div class="detail-accent active"></div><div class="detail-name">모델 프로파일</div><span class="detail-kind">표시</span></div><p class="developer-copy">settings.json 의 <code>models.profiles</code> 를 보여줍니다. 각 프로파일은 이름·설명·풀(provider:model, 폴백 순서 →)·폴백 프로파일로 구성됩니다. 추가·수정은 대화로 요청하세요(비서가 settings.json 을 편집).</p><div id="models" class="models-shell"><div class="empty">불러오는 중…</div></div>';
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
          '<div class="detail-name">설정</div></div>';
        const row = document.createElement("div");
        row.className = "settings-row";
        const meta = document.createElement("div");
        meta.className = "settings-meta";
        const name = document.createElement("div");
        name.className = "settings-name";
        name.textContent = "다음 메시지 제안";
        const desc = document.createElement("div");
        desc.className = "settings-desc";
        desc.textContent =
          "턴이 끝나면 이어서 보낼 만한 말을 입력창에 회색으로 제안합니다. Tab 이면 입력창에 채워집니다(전송은 직접). 매 턴 토큰을 조금 씁니다.";
        meta.appendChild(name);
        meta.appendChild(desc);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-toggle" + (enabled ? " on" : "");
        btn.textContent = enabled ? "켜짐" : "꺼짐";
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
            showToast("다음 메시지 제안: " + (next ? "켜짐" : "꺼짐"), "good");
            renderSettingsRow(root, next); // 서버가 확인해 준 값으로 다시 그린다.
          } catch (e) {
            showToast("설정 저장 실패: " + e.message, "bad");
            btn.disabled = false;
          }
        });
        row.appendChild(meta);
        row.appendChild(btn);
        page.appendChild(row);
        page.appendChild(buildLogRow());
        page.appendChild(buildChangelogRow());
        root.appendChild(page);
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
        name.textContent = "오늘 로그";
        const desc = document.createElement("div");
        desc.className = "settings-desc";
        desc.textContent = "불러오는 중…";
        meta.appendChild(name);
        meta.appendChild(desc);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-toggle";
        btn.textContent = "비우기";
        btn.disabled = true;

        const fmtBytes = (n) =>
          n < 1024 ? n + "B"
          : n < 1024 * 1024 ? (n / 1024).toFixed(1) + "KB"
          : (n / 1024 / 1024).toFixed(1) + "MB";

        const paint = (s) => {
          if (!s || s.exists !== true) {
            desc.textContent = "오늘 기록된 로그가 아직 없습니다.";
            btn.disabled = true;
            return;
          }
          const ago = s.lastWriteTs ? fmtAgo(s.lastWriteTs) : "";
          const others = s.otherDays > 0 ? ` · 다른 날짜 ${s.otherDays}개는 그대로 둡니다` : "";
          desc.textContent =
            `${fmtBytes(s.bytes)}${ago ? " · 마지막 기록 " + ago : ""}${others}. ` +
            "비우면 파일은 남고 내용만 지워집니다(데몬은 계속 같은 파일에 씁니다).";
          btn.disabled = s.bytes === 0;
        };

        const load = async () => {
          try {
            const r = await fetch("/api/log-status");
            paint(r.ok ? await r.json() : null);
          } catch {
            desc.textContent = "로그 상태를 읽지 못했습니다.";
            btn.disabled = true;
          }
        };

        btn.addEventListener("click", async () => {
          if (!window.confirm(
            "오늘 로그를 비울까요?\n\n" +
            "되돌릴 수 없습니다. 로그는 문제가 생겼을 때 원인을 찾는 1차 자료입니다 — " +
            "지금 이상이 있는 상태라면 비우기 전에 확인하세요."
          )) return;
          btn.disabled = true;
          try {
            const r = await fetch("/api/log-clear", { method: "POST" });
            const d = await r.json().catch(() => ({}));
            if (r.ok && d.ok === true) {
              showToast(fmtBytes(d.clearedBytes || 0) + " 비웠습니다.", "good");
              paint(d.status); // 서버가 준 사후 상태로 그린다(스스로 증명한 값).
            } else {
              showToast("로그 비우기 실패: " + (d.error || "HTTP " + r.status), "bad");
              await load();
            }
          } catch (e) {
            showToast("로그 비우기 실패: " + e.message, "bad");
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
          '<div class="page-view"><div class="detail-head"><div class="detail-accent"></div><div class="detail-name">설정</div></div><div class="empty">불러오는 중…</div></div>';
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
        name.textContent = "변경 이력";
        const desc = document.createElement("div");
        desc.className = "settings-desc";
        desc.textContent = "이 설치본에 담긴 릴리스 노트입니다.";
        meta.appendChild(name);
        meta.appendChild(desc);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-toggle";
        btn.textContent = "보기";
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
            btn.textContent = "보기";
            btn.classList.remove("on");
            return;
          }
          wrap.hidden = false;
          btn.textContent = "접기";
          btn.classList.add("on");
          if (loaded) return; // 한 번만 받는다(파일은 재시작 전까지 안 바뀐다).
          body.className = "empty";
          body.textContent = "불러오는 중…";
          let md = "";
          try {
            const r = await fetch("/api/changelog");
            if (r.ok) md = String((await r.json()).markdown || "");
          } catch { /* 미도달 — 아래 안내로 떨어진다 */ }
          // ★없으면 **없다고 말한다** — 빈 화면으로 두면 "로딩 중" 과 구분이 안 된다.
          if (md.trim() === "") {
            body.textContent = "변경 이력을 찾지 못했습니다(CHANGELOG.md 부재).";
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
