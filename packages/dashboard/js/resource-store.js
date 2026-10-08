/**
 * **resource-store** — 스냅샷·이벤트·재연결을 **한 규칙**으로 푸는 자리 (2026-08-28, 증분 5a).
 *
 * ★계약은 서버(`src/core/resource-revision.ts`)가 이미 세워뒀는데 **화면 쪽이 비어 있었다.**
 *  실측: 대시보드 JS 어디에도 `revision`·`decideApply` 가 **0곳**이었다. 계약이 한쪽만 서
 *  있으면 그건 계약이 아니라 서버의 독백이다.
 *
 * 규칙은 한 줄이다:
 *
 *      event.revision === local.revision + 1 일 때만 적용한다.
 *      크면 → 중간을 놓쳤다 → 스냅샷을 다시 받는다.
 *      작거나 같으면 → 이미 본 것 → 버린다.
 *      세대(epoch)가 다르면 → 데몬이 재시작했다 → 스냅샷부터.
 *
 *  이 한 줄이 dedup 집합 · sticky 종료 · 순서 가드 · "replay 창 밖으로 밀린 긴 매니저" 를
 *  대체한다. 지금 `background-drawer.js` 에 그 방어가 47줄 흩어져 있다.
 *
 * ★**판정이 두 벌인 것은 런타임이 달라서다**(서버 TS / 브라우저 JS). 두 벌이면 갈리므로,
 *  회귀가 **같은 케이스 표로 양쪽을 실행해 대조**한다 — 그게 이 중복을 허용하는 유일한
 *  조건이다([[feedback_simple_composable_no_duplication]]). 그래서 `decideApply` 는 여기서
 *  **순수 함수**로 따로 서 있다(스토어 안에 숨기면 검사가 스토어를 띄워야 한다).
 *
 * ★**리소스를 열거하지 않는다.** 이름은 문자열이고, 플러그인이 새 리소스를 내면 코어 수정
 *  0으로 그 구독자에게 배달된다([[feedback_hand_maintained_lists]]).
 *
 * 쓰는 곳: SSE 문지기(`sse.js`)·백그라운드 드로어·위젯 호스트.
 */
(() => {
  /**
   * 이벤트를 어떻게 다룰까 — **서버 `decideApply` 와 같은 진리표**여야 한다.
   * @param {{epoch:string,revision:number}|null} local 지금 들고 있는 좌표(스냅샷 전이면 null)
   * @param {{epoch:string,revision:number}} event 받은 이벤트의 좌표
   * @returns {"apply"|"ignore"|"resnapshot"}
   */
  const decideApply = (local, event) => {
    if (local === null || local === undefined || local.epoch !== event.epoch) {
      return "resnapshot";
    }
    if (event.revision === local.revision + 1) return "apply";
    if (event.revision <= local.revision) return "ignore";
    return "resnapshot";
  };

  /**
   * 리소스 하나의 상태 + 구독자.
   *
   * ★**스냅샷 요청은 합친다.** 이벤트가 몰아치면 `resnapshot` 이 연달아 나오는데, 매번
   *  받으면 재연결 순간에 스냅샷 폭풍이 된다. 도는 중이면 그 약속에 합류한다.
   * ★**받는 사이에 온 이벤트는 «한 번 더 받기» 로 남긴다** (2026-10-08 외부 검토 F5). 종전엔 «스냅샷이 더 최신이므로»
   *  버렸는데, 서버가 스냅샷을 만든 **뒤**·응답이 닿기 **전**에 온 이벤트면 스냅샷이 더 옛것이다 — 그 변경이 다음 이벤트까지
   *  사라졌다. 큐는 두지 않는다: 끝나면 한 번 더 받으면 된다(몰아쳐도 한 번).
   * ★**늦게 온 스냅샷은 지금보다 오래됐으면 버린다** — 받는 사이 이벤트가 적용돼 리비전이 앞서 있으면, 옛 스냅샷이 그걸 되돌렸다.
   */
  const makeResource = (name, fetchSnapshot) => {
    let state = null; // { epoch, revision, data }
    let inflight = null;
    let again = false; // 받는 사이 이벤트가 «다시 받아라» 를 남겼다
    const subs = new Set();
    /** 진단용 — 검사와 사람이 "왜 이렇게 됐나" 를 볼 수 있게 센다. */
    const stats = { applied: 0, ignored: 0, resnapshots: 0, errors: 0 };

    const emit = () => {
      for (const fn of subs) {
        try {
          fn(state === null ? null : state.data, state);
        } catch (e) {
          // 한 구독자의 예외가 다른 구독자를 막지 않는다(위젯 하나가 화면을 안 죽인다).
          console.warn("[resource-store] 구독자 예외:", e);
        }
      }
    };

    const resnapshot = () => {
      if (inflight !== null) return inflight;
      stats.resnapshots += 1;
      inflight = Promise.resolve()
        .then(() => fetchSnapshot())
        .then((snap) => {
          // 스냅샷은 좌표를 들고 와야 한다 — 없으면 이 계약 밖이라 상태를 못 만든다.
          if (!snap || typeof snap.epoch !== "string" || typeof snap.revision !== "number") {
            // ★영문이다 — 이 문자열은 화면에 안 뜨고 `console.warn` 으로만 간다(개발자 진단).
            //  한국어를 쓰면 i18n 게이트가 "카탈로그를 안 타는 한국어" 로 잡는데, 그 게이트가
            //  옳다: 던진 문자열이 어디로 갈지는 여기서 알 수 없다. 기존 js 도 전부 영문이다.
            throw new Error("snapshot is missing epoch/revision");
          }
          if (state !== null && state.epoch === snap.epoch && snap.revision < state.revision) {
            stats.ignored += 1; // 받는 사이 더 새 리비전이 적용됐다 — 옛 스냅샷으로 되돌리지 않는다
            return;
          }
          state = { epoch: snap.epoch, revision: snap.revision, data: snap.data };
          emit();
        })
        .catch((e) => {
          stats.errors += 1;
          // ★상태를 **버리지 않는다** — 옛 값이라도 있는 게 빈 화면보다 낫고, 다음 이벤트가
          //  다시 `resnapshot` 을 부른다. 여기서 state=null 로 만들면 깜빡임이 생긴다.
          console.warn(`[resource-store] ${name} 스냅샷 실패:`, e);
        })
        .finally(() => {
          inflight = null;
          if (again) {
            again = false;
            void resnapshot();
          }
        });
      return inflight;
    };

    return {
      name,
      /** SSE 등에서 온 이벤트 하나. 판정에 따라 적용·무시·스냅샷 재요청. */
      handle(event, apply) {
        if (!event || typeof event.epoch !== "string" || typeof event.revision !== "number") {
          return "ignore"; // 계약 밖 이벤트 — 이 리소스 것이 아니다.
        }
        const decision = decideApply(state, event);
        if (decision === "apply") {
          state = {
            epoch: event.epoch,
            revision: event.revision,
            data: apply(state === null ? null : state.data, event),
          };
          stats.applied += 1;
          emit();
        } else if (decision === "ignore") {
          stats.ignored += 1;
        } else if (inflight !== null) {
          again = true; // 지금 받는 스냅샷이 이 이벤트보다 옛것일 수 있다 — 끝나면 한 번 더
        } else {
          void resnapshot();
        }
        return decision;
      },
      /** 구독 — 지금 값이 있으면 **즉시 한 번** 준다(구독자가 첫 값을 기다리지 않게). */
      subscribe(fn) {
        subs.add(fn);
        if (state !== null) {
          try {
            fn(state.data, state);
          } catch (e) {
            console.warn("[resource-store] 구독자 예외:", e);
          }
        } else {
          void resnapshot();
        }
        return () => subs.delete(fn);
      },
      resnapshot,
      state: () => (state === null ? null : { ...state }),
      stats: () => ({ ...stats, subscribers: subs.size }),
    };
  };

  const resources = new Map();

  window.resourceStore = {
    decideApply,
    /**
     * 리소스를 등록·조회한다. 같은 이름으로 다시 부르면 **같은 것**을 준다 —
     * 두 소비자가 각자 스냅샷을 받으면 그게 곧 두 벌의 진실이다.
     */
    resource(name, fetchSnapshot) {
      const has = resources.get(name);
      if (has !== undefined) return has;
      if (typeof fetchSnapshot !== "function") {
        throw new Error(`resource("${name}") requires fetchSnapshot on first registration`);
      }
      const r = makeResource(name, fetchSnapshot);
      resources.set(name, r);
      return r;
    },
    /** 진단용 — 지금 서 있는 리소스들. */
    state: () =>
      Object.fromEntries(
        [...resources].map(([n, r]) => [n, { ...r.stats(), coord: r.state() }]),
      ),
  };
})();
