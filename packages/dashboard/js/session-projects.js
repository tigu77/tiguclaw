      // session-projects.js — 이 대화(세션)에 연결한 프로젝트 (2026-10-08, docs/decisions/2026-10-08-session-project-links.md).
      //
      // 판단은 코어(`core/session-projects.ts`)가 한다 — 여기는 그 결과를 **그리기만** 한다:
      //  ·연결 줄(#chat-projects) — 컨텍스트 태그 줄 바로 아래, 📁 칩 + [+ 프로젝트]
      //  ·[+ 프로젝트] → «이 대화에 프로젝트 연결» 목록
      //  ·📁 칩 메뉴 — 그 프로젝트의 커맨드 · 프로젝트 상세(프로젝트 화면으로) · 연결 해제(확인)
      //  ·`/` 자동완성의 프로젝트 구획(slash.js 가 window.sessionProjectSlashItems 로 받는다)
      // 커맨드 실행은 텔레그램과 **같은 슬래시 명령**을 보낸다(`/project run …`) — 실행 경로가 채널마다 갈리지 않게.
      // ★상세는 대화에 PROJECT.md 를 찍지 않고 프로젝트 화면을 연다(2026-10-09 정태님) — 화면이 있는 채널이라 대화를 어지럽힐
      //  이유가 없고, 상세가 더 많이 보인다. 텔레그램은 화면이 없어 `/project show` 그대로다.
      (() => {
        // 활성 탭의 연결 상태 — {threadKey, linked:[{name,path,exists,commands:[{name,description}]}], available:[{name,path}]}
        let state = { threadKey: null, linked: [], available: [] };
        let seq = 0;

        const quote = (name) => (/\s/.test(name) ? '"' + name + '"' : name);
        const rerender = () => renderRow();

        const refresh = async () => {
          const tk = typeof activeThreadKey === "string" ? activeThreadKey : null;
          if (tk === null) return;
          const mine = ++seq;
          // 다른 탭으로 옮겼으면 응답을 기다리지 않고 비운다 — 옛 탭의 📁 칩이 남아 있으면 그걸 눌러 옛 세션을
          // 해제하게 된다(2026-10-08 적대 검토).
          if (state.threadKey !== tk) { state = { threadKey: tk, linked: [], available: [] }; rerender(); }
          try {
            const r = await fetch("/api/session-projects?threadKey=" + encodeURIComponent(tk));
            const d = r.ok ? await r.json() : null;
            if (mine !== seq) return; // 그 사이 탭이 바뀌었다 — 늦게 온 응답으로 덮지 않는다.
            state = {
              threadKey: tk,
              linked: d && Array.isArray(d.linked) ? d.linked : [],
              available: d && Array.isArray(d.available) ? d.available : [],
            };
          } catch {
            if (mine !== seq) return;
            state = { threadKey: tk, linked: [], available: [] };
          }
          rerender();
        };

        const post = async (action, project) => {
          const tk = state.threadKey;
          if (tk === null) return;
          try {
            await fetch("/api/session-projects", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ threadKey: tk, action, project }),
            });
          } catch {}
          await refresh(); // 이벤트로도 오지만 누른 화면은 바로 맞춘다.
        };

        // ── 칩 ────────────────────────────────────────────────────────────
        const linkedChips = () =>
          state.linked.map((p) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "ctx-chip ctx-linked" + (p.exists ? "" : " ctx-missing");
            chip.title = p.exists ? p.path : i18n("sproj.folderMissing", { path: p.path });
            chip.textContent = "📁 " + p.name + " ▾";
            chip.addEventListener("click", () => openMenu("sessionProject", { label: p.name, targetId: p.path, project: p }, { anchor: chip }));
            return chip;
          });

        // ★등록된 프로젝트가 하나도 없어도 버튼은 보인다 — 숨기면 이 기능도, 등록하는 법도 화면에서 알 길이 없다(2026-10-08 정태님).
        //  연결할 게 더 없는 경우(전부 이미 연결)만 숨긴다.
        const addButton = () => {
          if (state.available.length === 0 && state.linked.length > 0) return null;
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ctx-chip ctx-add ctx-link-add";
          b.textContent = i18n("sproj.add");
          b.title = i18n("sproj.pickTitle");
          b.addEventListener("click", () => openMenu("sessionProjectPick", {}, { anchor: b }));
          return b;
        };

        const renderRow = () => {
          const row = document.getElementById("chat-projects");
          if (!row) return;
          row.innerHTML = "";
          for (const chip of linkedChips()) row.appendChild(chip);
          const add = addButton();
          if (add) row.appendChild(add);
        };

        // ── 메뉴 ──────────────────────────────────────────────────────────
        // 등록된 프로젝트가 없을 때의 안내 — 프로젝트 페이지의 빈 화면과 **같은 문구 키**(한 곳에서 같은 말을 한다).
        const emptyGuide = () => {
          const name = typeof assistantName === "string" ? assistantName : "tiguclaw";
          return [
            i18n("proj.empty.title"),
            i18n("proj.empty.lead", { name }),
            i18n("proj.empty.ex1", { quote: i18n("proj.empty.ex1.text", { path: "~/work/myapp" }) }),
            i18n("proj.empty.ex2", { quote: i18n("proj.empty.ex2.text") }),
          ].map((label, i) => ({ id: "empty" + i, header: true, label }));
        };
        registerMenuItems("sessionProjectPick", () => [
          { id: "head", header: true, label: i18n("sproj.pickTitle") },
          ...(state.available.length === 0 ? emptyGuide() : []),
          ...state.available.map((p) => ({
            id: "link:" + p.path,
            icon: "📁",
            label: p.name,
            action: { kind: "builtin", handler: "sessionProject.link", args: { path: p.path } },
          })),
        ]);
        registerBuiltinHandler("sessionProject.link", (_ctx, args) => post("link", args.path));

        // 커맨드를 폴더대로 묶는다 — `aaa/bbb/ccc.md` 는 aaa › bbb › /ccc. 폴더가 없으면 지금처럼 평평하다.
        const commandTree = (cmds, q) => {
          const top = [];
          const dirs = new Map();
          const dirItem = (folder) => {
            if (!folder) return null;
            if (dirs.has(folder)) return dirs.get(folder);
            const cut = folder.lastIndexOf("/");
            const it = { id: "dir:" + folder, group: "commands", icon: "📂", label: folder.slice(cut + 1), children: [] };
            dirs.set(folder, it);
            const parent = dirItem(cut === -1 ? "" : folder.slice(0, cut));
            (parent ? parent.children : top).push(it);
            return it;
          };
          for (const c of cmds) {
            const item = {
              id: "cmd:" + c.name,
              group: "commands",
              icon: c.run ? "▶" : "💬", // ▶ 실행형(비서 없이 셸) · 💬 프롬프트형(비서에게)
              label: "/" + c.name + (c.description ? " — " + c.description : ""),
              action: { kind: "send_message", template: "/project run " + q + " " + c.name },
            };
            const dir = dirItem(c.folder || "");
            (dir ? dir.children : top).push(item);
          }
          return top;
        };

        registerMenuItems("sessionProject", (ctx) => {
          const p = ctx.project;
          if (!p) return [];
          const q = quote(p.name);
          const cmds = Array.isArray(p.commands) ? p.commands : [];
          return [
            ...(p.exists ? [] : [{ id: "missing", header: true, label: i18n("sproj.folderMissing", { path: p.path }) }]),
            ...commandTree(cmds, q),
            ...(p.exists && cmds.length === 0 ? [{ id: "nocmd", group: "commands", header: true, label: i18n("sproj.noCommands") }] : []),
            { id: "detail", group: "info", icon: "📄", label: i18n("sproj.openDetail"), action: { kind: "builtin", handler: "sessionProject.openDetail", args: { path: p.path } } },
            {
              id: "unlink",
              danger: true,
              icon: "⛓",
              label: i18n("sproj.unlink"),
              confirm: i18n("sproj.unlinkConfirm", { name: p.name }),
              action: { kind: "builtin", handler: "sessionProject.unlink", args: { path: p.path } },
            },
          ];
        });
        registerBuiltinHandler("sessionProject.unlink", (_ctx, args) => post("unlink", args.path));
        registerBuiltinHandler("sessionProject.openDetail", (_ctx, args) => {
          applyView("projects"); // 모바일은 본문 탭까지 넘긴다
          void openProjectDetail(args.path);
          // ★모바일은 **상세를 연 쪽이** 상세 화면(m-detail)을 켠다 (2026-10-09 적대 검토). 목록 행을 누르면 mobile-nav 가 켜 주지만
          //  여긴 행 클릭이 아니라서 목록 화면에 착지했다. 그리고 mobile-nav 는 뷰 전환(data-view)을 보고 «새 뷰는 목록부터» 로
          //  **마이크로태스크에서** 끈다 — 그 관측자 콜백은 위 전환 때 이미 줄에 섰으므로, 그 **뒤**에 켠다.
          if (window.matchMedia("(max-width: 900px)").matches) queueMicrotask(() => document.body.classList.add("m-detail"));
        });

        // ── `/` 자동완성 구획 ─────────────────────────────────────────────
        // 넣을 글: 이름이 하나뿐이고 다른 명령과 안 겹치면 `/이름 ` — 아니면 `/project run "<프로젝트>" 이름 `
        // (겹치는 이름을 짧게 넣으면 다른 것이 돈다 · 고르는 버튼이 한 번 더 뜬다).
        const slashItems = (prefix, globalNames) => {
          const count = new Map();
          for (const p of state.linked) for (const c of p.commands || []) count.set(c.name, (count.get(c.name) || 0) + 1);
          const out = [];
          for (const p of state.linked) {
            for (const c of p.commands || []) {
              if (!String(c.name).toLowerCase().startsWith(prefix)) continue;
              const plain = count.get(c.name) === 1 && !globalNames.has(c.name);
              out.push({
                name: c.name,
                description: (c.run ? "▶ " : "") + (c.description || ""),
                group: "📁 " + p.name,
                folder: c.folder,
                insert: plain ? "/" + c.name + " " : "/project run " + quote(p.name) + " " + c.name + " ",
              });
            }
          }
          return out;
        };

        window.refreshSessionProjects = refresh;
        window.sessionProjectSlashItems = slashItems;
        void refresh();
      })();
