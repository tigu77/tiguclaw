      /**
       * **모바일 헤더 자리 맞추기** (2026-10-20 정태님 신고: *«모바일 대시보드에서 업데이트 버튼이 뜰 때 패널이 밀려서 보여»*).
       *
       * ★원인: 낱말 접기(검색·백그라운드)가 `@media (max-width:359px)` 고정 문턱이었다. 그 문턱은 09-09 에 «320px 까지 안 넘친다» 는
       *  헤드리스 실측으로 정했는데, **업데이트 칩이 숨은 상태에서 잰 값**이었다. 칩(+«?»)이 뜨면 헤더가 443px 를 요구해 430px 이하 폰에서
       *  넘쳤고, 홈 화면에선 브라우저가 페이지 폭을 443px 로 넓혀 화면 전체가 밀렸다(10-20 재측정 — 칩O 320~414px 넘침).
       * ★그래서 문턱을 **숫자로 정하지 않는다** — 헤더에 무엇이 떠 있든(칩·배지·글자 수·언어) **실제로 넘치는지**를 재서 필요한 만큼만 접는다.
       *  정확한 값(`scrollWidth`)이 이미 있으니 근사(폭 문턱)를 쓰지 않는다. 넓으면 낱말이 그대로 보인다(09-09 «유연하게» 그대로).
       *
       * 접는 순서(`HEADER_FIT_STAGES`) — 뜻은 `aria-label`·`title`·숨은 글자가 지킨다(모양만 줄이고 의미는 안 줄인다):
       *  ①검색·백그라운드·위젯 낱말 → ②업데이트 칩을 기호로 → ③«?»·⭐(설정에서도 열린다) → ④브랜드 낱말(로고 아이콘은 남는다).
       *  ★④는 레드팀 10-20: 🧩 버튼이 헤더에 더해진 뒤 320~340px + 칩에선 ①~③을 다 접어도 넘쳐 칩이 잘렸다.
       *  ★데스크톱에도 건다 — 넘칠 때만 접으므로 넓은 화면은 그대로다(901~960px 에 패널을 열면 헤더 끝이 패널 밑에 깔렸다).
       */
      const HEADER_FIT_STAGES = ["fit-words", "fit-chip", "fit-notes", "fit-brand"];

      /**
       * 넘치지 않는 **가장 적은** 접기 단계 — 순수 함수. `overflows(n)` = n단계까지 접었을 때 넘치나.
       * 다 접어도 넘치면 마지막 단계(더 접을 게 없다 — 그때는 헤더의 `overflow:hidden` 이 페이지를 지킨다).
       * @param {(n: number) => boolean} overflows
       * @param {number} max
       */
      const headerFitStage = (overflows, max) => {
        for (let n = 0; n < max; n += 1) if (!overflows(n)) return n;
        return max;
      };

      const headerFit = (() => {
        const header = document.querySelector("header");
        if (!header) return { fit: () => {} };
        const narrow = window.matchMedia("(max-width: 900px)");
        const apply = (n) => HEADER_FIT_STAGES.forEach((c, i) => header.classList.toggle(c, i < n));
        const fit = () => {
          apply(headerFitStage((n) => { apply(n); return header.scrollWidth > header.clientWidth; }, HEADER_FIT_STAGES.length));
        };
        let queued = false;
        const schedule = () => {
          if (queued) return;
          queued = true;
          requestAnimationFrame(() => { queued = false; fit(); });
        };
        // 다시 재는 때: 폭이 바뀔 때(창 · 패널이 헤더를 밀 때 — body 클래스) · 헤더에 무엇이 뜨거나 사라질 때(칩 `hidden`·버튼 이동·글자·배지).
        // ★`class` 는 안 본다 — 우리가 헤더에 다는 접기 클래스가 다시 이 관찰을 깨워 맴돌지 않게.
        window.addEventListener("resize", schedule);
        narrow.addEventListener("change", schedule);
        new MutationObserver(schedule).observe(header, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
        // 패널을 열고 닫으면 헤더 폭이 margin-right 로 바뀐다(창 크기는 그대로) — body 의 class 변화로 안다. 전이(0.2초) 뒤 한 번 더.
        new MutationObserver(() => { schedule(); setTimeout(schedule, 250); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule, () => {});
        schedule();
        return { fit };
      })();
