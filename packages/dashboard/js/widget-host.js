      /**
       * **위젯 호스트** — 플러그인이 채팅에 그림을 그릴 수 있게 하는 자리 (2026-08-28, 증분 1).
       *
       * ★설계: `docs/decisions/2026-08-28-widget-platform.md`. 위젯은 **비서 답변에 딸린
       *  첨부**다(`attachments: [{ kind:"widget", widget:"<plugin>/<name>", data:{…} }]`).
       *  그 자리를 고른 이유는 취향이 아니라 **저장·복원·가상화·프루닝·검색이 전부 메시지
       *  것을 타서 공짜로 오기 때문**이다(후보 셋을 9가지 요구에 대고 재서 골랐다).
       *
       * ★**이 파일이 코어가 위젯을 위해 해주는 전부다.** 무엇을 부르나·키·동의·어떻게
       *  그리나는 플러그인 몫이다(정태님: *"거추장스러운 걸 코어가 해결하는 게 아니야,
       *  그걸 해결하라고 플러그인 기반을 잡는 거지"*). 여기가 맡는 건 셋뿐이다:
       *  **①코드를 데려온다 ②그릴 자리를 준다 ③치울 때 치운다.**
       *
       * ★**목록을 안 만든다.** 어떤 플러그인이 위젯을 갖는지 미리 알 필요가 없다 —
       *  첨부가 `widget: "weather/forecast"` 라고 말하면 그때 `/plugin-asset/weather/widget.js`
       *  를 **처음 한 번** 데려온다(mermaid 지연 로드와 같은 형). 플러그인이 늘어도 여기는
       *  안 고친다([[feedback_hand_maintained_lists]]).
       */
      const widgetHost = (() => {
        /** `<plugin>/<name>` → { mount, unmount }. 플러그인 스크립트가 채운다. */
        const builders = new Map();
        /** 플러그인 이름 → 스크립트 로드 Promise. 같은 플러그인은 한 번만 데려온다. */
        const loading = new Map();
        /**
         * 플러그인 이름 → 자기 번역 카탈로그.
         *
         * ★**번역은 플러그인 책임이다**(정태님, 2026-08-28). 코어 카탈로그에 남의 문구를
         *  넣을 수는 없다 — 플러그인마다 늘어나고, 우리가 번역할 수도 없다.
         * ★없으면 그냥 없는 채로 둔다(키가 그대로 보인다). 조용히 한국어를 박아 넣으면
         *  영어 사용자가 한국어를 보는데 **아무도 그걸 모른다** — 실제로 그랬다.
         */
        const catalogs = new Map();
        /** 지금 붙어 있는 것 — 노드 → { id, dispose[] }. */
        const live = new Map();
        /**
         * **아직 문서에 안 들어간 것** — 노드 → 첨부.
         *
         * ★가상화가 노드를 **창 안에 들어올 때** 삽입한다. 위로 스크롤해야 보이는 메시지는
         *  빌드는 됐어도 DOM 엔 없다 — 그 시점에 마운트를 포기하면 **스크롤해도 영영 안 뜬다.**
         *  실제로 새로고침 뒤 위젯이 안 보였고, 스크립트는 로드됐는데 `live:0` 이었다.
         */
        const pending = new Map();
        /**
         * 대기줄 상한.
         *
         * ★되돌린 것이 **영영 안 붙을 수도** 있다(프루닝으로 부분트리가 통째로 버려질 때).
         *  그 경우를 정확히 가려내려면 "언제까지 안 붙으면 버린다" 는 추정이 필요한데, 잘못
         *  버리면 *"스크롤해도 영영 안 뜬다"* 가 돌아온다. 그래서 **가려내는 대신 묶는다** —
         *  창에 들어올 만한 것은 항상 최근 것이므로 오래된 쪽부터 버린다.
         */
        const PENDING_MAX = 32;
        const queuePending = (el, att) => {
          if (pending.size >= PENDING_MAX) {
            const oldest = pending.keys().next();
            if (!oldest.done) pending.delete(oldest.value);
          }
          pending.set(el, att);
          ensureObserver();
        };
        let observer = null;

        /**
         * ★**떼어질 때 치운다.** 채팅은 노드를 **분리**(가상화)하고 **폐기**(프루닝)한다 —
         *  실측으로 확인한 사실이다. 타이머·구독을 든 위젯이 그대로 남으면, **상시 띄워두는**
         *  제품에서 그건 곧 누수다. 그래서 회수를 **플러그인의 성실함에 맡기지 않고**
         *  여기서 한다.
         * ★관측자는 **위젯이 하나라도 붙어 있을 때만** 돈다. 위젯이 없는 지금(그리고 위젯을
         *  안 쓰는 사용자)에겐 비용이 정확히 0이다 — 채팅은 메시지마다 DOM 이 바뀌는 자리라
         *  상시 관측을 켜 둘 곳이 아니다.
         *
         * @param requeue 떼어져서 회수하는가(=다시 붙으면 다시 그린다) — 기본 참.
         *   ★**던져서 회수할 때는 거짓**이다. 실패한 위젯을 대기줄에 되돌리면 다음 DOM 변화에
         *    또 그리고 또 던진다 — 그리고 실패 폴백이 스스로 `textContent` 를 써서 DOM 을
         *    바꾸므로 **자기가 자기를 다시 깨우는 무한 루프**가 된다(실측: 페이지가 멈췄다).
         *    되돌림을 넣자마자 나온 결함이라 여기 적어 둔다.
         */
        const sweep = (node, requeue = true) => {
          if (!(node instanceof HTMLElement)) return;
          const hit = [];
          if (live.has(node)) hit.push(node);
          for (const el of node.querySelectorAll("[data-widget]")) {
            if (live.has(el)) hit.push(el);
          }
          for (const el of hit) {
            const entry = live.get(el);
            live.delete(el);
            for (const fn of entry.dispose) {
              try { fn(); } catch { /* 한 위젯의 정리 실패가 나머지를 막지 않는다 */ }
            }
            const b = builders.get(entry.id);
            if (b && typeof b.unmount === "function") {
              try { b.unmount(el); } catch { /* 같은 이유 */ }
            }
            // ★**다시 붙으면 다시 그린다** (2026-08-28, 지도 위젯이 잡았다).
            //  설계 §F 는 *"mount 는 여러 번 불릴 수 있다(스크롤로 돌아옴)"* 라고 적어뒀는데
            //  **그 계약이 구현돼 있지 않았다** — 회수만 하고 대기줄에 안 돌려놔서, 가상화가
            //  접었다 편 위젯은 **영영 빈 칸**이 됐다(실측: 왕복 뒤 행 높이 383→92, 컨테이너는
            //  남고 안이 텅 빔). 증분 1 검증이 "새로고침 복원"(한 번도 안 붙은 노드)만 봐서
            //  이 경로가 통째로 사각지대였다.
            // ★부모가 있을 때만 되돌린다 — 부모까지 없으면 영영 안 붙는다(아래 같은 판정).
            if (requeue && el.parentNode !== null) queuePending(el, entry.att);
          }
          stopIfIdle();
        };

        /**
         * 관측자 하나가 **두 일**을 한다 — 들어오면 마운트, 나가면 회수.
         * ★`pending` 도 `live` 도 없으면 **끈다**: 채팅은 메시지마다 DOM 이 바뀌는 자리라
         *  상시 관측을 켜 둘 곳이 아니고, 위젯을 안 쓰는 사용자에겐 비용이 0이어야 한다.
         */
        const stopIfIdle = () => {
          if (pending.size === 0 && live.size === 0 && observer !== null) {
            observer.disconnect();
            observer = null;
          }
        };
        const ensureObserver = () => {
          if (observer !== null) return;
          // ★**문서 전체를 본다.** 종전엔 `#chat` 에 달았는데 채팅 메시지는 거기가 아니라
          //  `#stream` 안의 가상화 창(`.vt-window`)에 들어간다 — 그래서 삽입을 **한 번도
          //  못 봤다**(새로고침 뒤 위젯이 `pending` 에 갇혀 있었다).
          //  ★고침은 "맞는 id 를 찍는 것" 이 아니다. 그러면 DOM 이 한 번 더 움직일 때 또
          //   조용히 깨진다. 관측자는 **위젯이 있을 때만** 돌므로(없으면 정확히 0), 범위를
          //   문서로 올려 id 결합을 없애는 쪽이 싸고 튼튼하다.
          const host = document.body;
          observer = new MutationObserver((records) => {
            for (const r of records) {
              for (const n of r.removedNodes) sweep(n);
            }
            if (pending.size > 0) flushPending();
          });
          observer.observe(host, { childList: true, subtree: true });
        };
        /** 문서에 들어온 대기분을 마운트한다. */
        const flushPending = () => {
          for (const [el, att] of [...pending]) {
            if (!el.isConnected) continue;
            pending.delete(el);
            void doMount(el, att);
          }
          stopIfIdle();
        };

        /** 플러그인 스크립트를 **한 번만** 데려온다. 실패해도 다시 시도할 수 있게 남긴다. */
        const loadPlugin = (plugin) => {
          const has = loading.get(plugin);
          if (has !== undefined) return has;
          const base = "/plugin-asset/" + encodeURIComponent(plugin);
          // 카탈로그는 **덤**이다 — 없거나 못 받아도 위젯은 뜬다(키가 보일 뿐).
          const locale =
            (window.__TIGU_I18N__ && window.__TIGU_I18N__.locale) || "ko";
          const wantCatalog = fetch(base + "/locales/" + encodeURIComponent(locale) + ".json")
            .then((r) => (r.ok ? r.json() : null))
            .then((c) => {
              if (c && typeof c === "object") catalogs.set(plugin, c);
            })
            .catch(() => { /* 없으면 없는 대로 */ });
          const p = new Promise((resolve, reject) => {
            const el = document.createElement("script");
            el.src = base + "/widget.js";
            el.onload = () => void wantCatalog.then(resolve);
            el.onerror = () => { loading.delete(plugin); reject(new Error("load failed")); };
            document.head.appendChild(el);
          });
          loading.set(plugin, p);
          return p;
        };

        /**
         * 첨부 하나를 위젯으로 그린다.
         * @param {HTMLElement} el 우리가 준 빈 컨테이너. 플러그인은 **그 안만** 만진다.
         * @param {{widget?:string, data?:unknown}} att
         */
        const mount = async (el, att) => {
          const id = att && typeof att.widget === "string" ? att.widget : "";
          const slash = id.indexOf("/");
          if (slash <= 0) return false; // `<plugin>/<name>` 이 아니면 위젯이 아니다.
          const plugin = id.slice(0, slash);

          if (!builders.has(id)) {
            try { await loadPlugin(plugin); } catch { return false; }
          }
          if (typeof builders.get(id)?.mount !== "function") return false;

          // ★**아직 안 붙었으면 기다린다** — 포기하지 않는다. 라이브 경로는 같은 태스크에서
          //  삽입되지만, 새로고침 복원은 **가상화가 창에 들어올 때** 넣는다. 빌드 시점에
          //  한 번 보고 포기하면 스크롤해도 영영 안 뜬다(실사용이 그렇게 잡혔다).
          if (!el.isConnected) {
            // ★**부모가 없으면 영영 안 붙는다** (2026-08-28, 홈 위젯 실측). 아무도 그 노드를
            //  들고 있지 않다는 뜻이라 삽입될 일이 없는데, 대기줄에 넣으면 `stopIfIdle` 이
            //  영원히 안 걸려 **관측자가 계속 돈다** — 이 파일이 스스로 약속한 *"위젯을 안
            //  쓰면 비용 0"* 이 그 순간 거짓이 된다. 화면은 멀쩡하므로 **보이지 않는 결함**이다.
            // ★**남은 구멍을 정직하게 적는다**: 이 가드는 *부모가 없는* 노드만 막는다. 부모는
            //  있는데 그 부분트리가 통째로 버려지는 경우(가상화가 만든 트리를 안 붙이고 버림)는
            //  여전히 고인다 — 실측 1건 관측(안 늘어남). 그걸 막으려면 "언제까지 안 붙으면
            //  버린다" 같은 추정이 필요한데, 잘못 버리면 *"스크롤해도 영영 안 뜬다"* 가 돌아온다.
            //  값이 확실한 쪽만 지금 막는다.
            // ★정당한 대기분은 **부모가 있다** — 호출부가 `wrap.appendChild(box)` 를 먼저
            //  하고 부르기 때문이다(가상화가 그 `wrap` 을 나중에 문서에 넣는다).
            if (el.parentNode === null) return false;
            queuePending(el, att);
            return false;
          }
          return doMount(el, att);
        };

        /** 문서에 들어와 있는 컨테이너에 실제로 그린다. */
        const doMount = (el, att) => {
          const id = att.widget;
          // ★플러그인 이름을 **여기서 다시 구한다.** 함수를 가르면서 `slash` 를 저쪽에 두고
          //  왔더니 참조 에러가 났고, 그 예외를 폴백이 삼켜 **위젯 자리에 "그리지 못했습니다"**
          //  만 남았다 — 헤드리스가 아니었으면 "왜 안 뜨지" 로 한참 헤맸을 자리다.
          const owner = id.slice(0, id.indexOf("/"));
          const b = builders.get(id);
          if (!b || typeof b.mount !== "function") return false;

          // ★**붙을 때까지 잠깐 기다린다.** 호출부(`buildAttachmentsPreview`)는 컨테이너를
          //  만들어 `wrap` 에 붙이고 우리를 부르는데, 그 `wrap` 이 문서에 들어가는 건
          //  **그 다음**이다. 즉 이 시점의 `isConnected` 는 아직 false 다.
          //
          //  ★**한 틱으로는 부족하다** (2026-08-28, 실사용이 잡았다). 라이브 경로는 같은 태스크
          //   안에서 삽입되지만, **새로고침 복원**은 다르다 — `buildHistoryDiv` 가 만든 노드를
          //   **가상화가 나중에** 배치 삽입한다. 그래서 한 틱 뒤에도 안 붙어 있고, 위젯이
          //   **조용히 안 그려졌다**(스크립트는 로드됐는데 `live:0`). 첫 판은 라이브만 보고
          //   고쳤던 것이다.
          //
          //  ★관측자를 하나 더 달지 않고 **유한 재시도**로 푼다: 위젯이 없을 때 비용이 0이어야
          //   하는데(채팅은 메시지마다 DOM 이 바뀐다), 삽입 감지용 상시 관측은 그 반대다.
          //  ★타이머다 — `requestAnimationFrame` 은 배경 탭에서 안 뛴다.
          const dispose = [];
          const ctx = {
            /** 위젯이 타이머·구독을 맡기는 자리. 코어가 회수한다. */
            onDispose: (fn) => { if (typeof fn === "function") dispose.push(fn); },
            /** 지금 화면 언어 — 카탈로그로 못 푸는 것(날짜·숫자·정렬 서식)에 쓴다. */
            locale: (window.__TIGU_I18N__ && window.__TIGU_I18N__.locale) || "ko",
            /**
             * 문구 — **플러그인 카탈로그만** 본다. 없으면 키를 그대로 돌려준다.
             *
             * ★**코어 테이블로 넘어가지 않는다** (2026-08-28 정태님 지적). 첫 판은 폴백을
             *  뒀는데 그게 경계를 무너뜨린다: 플러그인이 `common.cancel` 같은 키를 쓰면
             *  **우리 문구가 조용히 잡히고**, 나중에 우리가 그 문구를 고치면 남의 위젯
             *  의미가 같이 바뀐다. 빠진 키를 "되는 것처럼" 보이게 만드는 것도 나쁘다 —
             *  그러면 아무도 안 고친다.
             * ★키가 그대로 보이는 건 실패지만 **보이는 실패**다. 그게 이 경계의 값이다.
             * ★호스트가 공통 문구를 주고 싶어지면 **명시적으로** 준다(`ctx.common` 같은 것) —
             *  키 충돌로 우연히 되는 길은 만들지 않는다. 지금은 필요 없다.
             */
            /**
             * **살아 있는 값을 구독한다** — 위젯이 순서·재연결·스냅샷을 몰라도 되게
             * (2026-08-28, 증분 5). 계약은 `resource-store` 한 곳에 있고 위젯은 값만 받는다.
             *
             * ★**해지를 코어가 한다** — `onDispose` 에 걸어두므로 위젯이 잊어도 샌다.
             *  그게 이 호스트가 존재하는 이유다(플러그인의 성실함에 안 기댄다).
             * ★없는 리소스면 **조용히 아무 일도 안 한다**(구독이 no-op). 위젯이 코어보다
             *  새 버전일 수 있고, 그때 던지면 카드 하나가 아니라 그 위젯 전체가 죽는다.
             */
            resource: (name) => ({
              subscribe: (fn) => {
                const store = window.resourceStore;
                if (typeof store !== "object" || store === null) return () => {};
                let off = () => {};
                try {
                  off = store.resource(name).subscribe(fn);
                } catch {
                  return () => {}; // 아직 아무도 등록 안 한 리소스 — 조용히 논다.
                }
                dispose.push(off);
                return off;
              },
            }),
            t: (key, params) => {
              const own = catalogs.get(owner);
              const raw = own && typeof own[key] === "string" ? own[key] : undefined;
              if (raw === undefined) return String(key);
              return String(raw).replace(/\{(\w+)\}/g, (m, k) =>
                params && params[k] !== undefined ? String(params[k]) : m,
              );
            },
          };
          live.set(el, { id, att, dispose });
          ensureObserver();
          try {
            b.mount(el, att.data, ctx);
          } catch {
            // ★위젯 하나가 던져도 **채팅은 안 죽는다**(mermaid 폴백과 같은 규칙).
            sweep(el, false); // ★던진 것은 되돌리지 않는다 — 무한 재시도가 된다.
            el.textContent = typeof i18n === "function" ? i18n("widget.failed") : "";
            el.classList.add("widget-failed");
            return false;
          }
          return true;
        };

        return {
          /** ★플러그인이 쓸 문. 같은 id 재등록은 **거부**한다(조용한 덮어쓰기 금지). */
          register: (id, builder) => {
            if (typeof id !== "string" || id.indexOf("/") <= 0) return false;
            if (builders.has(id)) return false;
            if (!builder || typeof builder.mount !== "function") return false;
            builders.set(id, builder);
            return true;
          },
          mount,
          /** 검사·진단용. */
          state: () => ({
            builders: [...builders.keys()],
            live: live.size,
            pending: pending.size,
            observing: observer !== null,
          }),
        };
      })();

      // ★전역 하나 — 플러그인 번들은 우리 모듈 스코프 **밖**에서 로드되므로 이름으로 닿을
      //  자리가 하나는 있어야 한다. 이건 줄일 대상이 아니라 **의도된 확장점**이다.
      window.tiguWidgets = { register: widgetHost.register };
