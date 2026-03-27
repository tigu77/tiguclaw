//! GoalRunner — plan → execute → validate 피드백 루프 핵심 구현.

use tokio::sync::mpsc;
use tracing::{error, info, warn};

use tiguclaw_goal::types::{Goal, GoalStatus, PhaseStatus};
use tiguclaw_goal::GoalStore;
use tiguclaw_planner::validator::ValidationResult;
use tiguclaw_planner::{LlmPlanner, LlmValidator};

use crate::executor::PhaseExecutor;

// ─── GoalRunner ───────────────────────────────────────────────────────────────

/// Goal을 받아 plan → execute → validate 루프를 돌린다.
pub struct GoalRunner {
    planner: LlmPlanner,
    validator: LlmValidator,
    executor: PhaseExecutor,
    store: GoalStore,
    /// 완료/실패 시 사용자에게 결과를 전달할 채널.
    report_tx: mpsc::Sender<String>,
}

impl GoalRunner {
    pub fn new(
        planner: LlmPlanner,
        validator: LlmValidator,
        executor: PhaseExecutor,
        store: GoalStore,
        report_tx: mpsc::Sender<String>,
    ) -> Self {
        Self {
            planner,
            validator,
            executor,
            store,
            report_tx,
        }
    }

    /// Goal을 실행한다. plan → execute → validate 루프.
    ///
    /// 완료/실패 시 `report_tx`로 결과 문자열을 전송한다.
    pub async fn run(&self, goal_description: &str) {
        let mut goal = Goal::new(goal_description);
        info!("GoalRunner: starting goal={} id={}", goal.description, goal.id);

        if let Err(e) = self.store.save(&goal) {
            error!("Failed to save initial goal: {e}");
        }

        'outer: loop {
            // ── 1. Plan ──────────────────────────────────────────────────────
            goal.status = GoalStatus::Planning;
            goal.touch();
            self.persist(&goal);

            let phases = match self.planner.plan(&goal.description).await {
                Ok(p) => p,
                Err(e) => {
                    let reason = format!("Planning failed: {e}");
                    self.fail(&mut goal, &reason).await;
                    return;
                }
            };

            goal.phases = phases;
            info!("GoalRunner: planned {} phases", goal.phases.len());

            // ── 2. Execute + Validate 순서대로 ──────────────────────────────
            goal.status = GoalStatus::Executing { current_phase: 0 };
            goal.touch();
            self.persist(&goal);

            let phase_count = goal.phases.len();
            let mut i = 0;
            while i < phase_count {
                goal.status = GoalStatus::Executing { current_phase: i };
                goal.touch();
                self.persist(&goal);

                // Execute
                let result = match self.executor.execute(&goal.phases[i]).await {
                    Ok(r) => r,
                    Err(e) => {
                        warn!("Phase {} execution error: {e}", i);
                        format!("Execution error: {e}")
                    }
                };

                // Store result in phase
                goal.phases[i].result = Some(result.clone());

                // Validate
                let phase_snapshot = goal.phases[i].clone();
                let decision = match self
                    .validator
                    .validate(&goal, &phase_snapshot, &result)
                    .await
                {
                    Ok(d) => d,
                    Err(e) => {
                        let reason = format!("Validation failed: {e}");
                        self.fail(&mut goal, &reason).await;
                        return;
                    }
                };

                match decision {
                    ValidationResult::Pass => {
                        goal.phases[i].status = PhaseStatus::Completed;
                        goal.touch();
                        self.persist(&goal);
                        info!("GoalRunner: phase {} passed", i);
                        i += 1;
                    }
                    ValidationResult::Fail {
                        reason,
                        should_replan: true,
                    } => {
                        warn!("GoalRunner: phase {} failed (replan), reason={}", i, reason);

                        if !goal.can_retry() {
                            let msg = format!(
                                "최대 재시도({}) 초과 — 포기",
                                goal.max_attempts
                            );
                            self.fail(&mut goal, &msg).await;
                            return;
                        }

                        goal.attempt += 1;
                        goal.status = GoalStatus::Replanning {
                            feedback: reason.clone(),
                        };
                        goal.touch();
                        self.persist(&goal);

                        // 재계획
                        let new_phases = match self.planner.replan(&goal, &reason).await {
                            Ok(p) => p,
                            Err(e) => {
                                let msg = format!("Replan failed: {e}");
                                self.fail(&mut goal, &msg).await;
                                return;
                            }
                        };
                        goal.phases = new_phases;
                        continue 'outer; // 처음부터 재실행
                    }
                    ValidationResult::Fail {
                        reason,
                        should_replan: false,
                    } => {
                        warn!("GoalRunner: phase {} failed (no replan), reason={}", i, reason);
                        goal.phases[i].status = PhaseStatus::Failed {
                            reason: reason.clone(),
                        };
                        self.fail(&mut goal, &reason).await;
                        return;
                    }
                }
            }

            // ── 3. 모든 Phase 완료 ───────────────────────────────────────────
            goal.status = GoalStatus::Completed;
            goal.touch();
            self.persist(&goal);

            let msg = format!("✅ Goal 완료: {}", goal.description);
            info!("GoalRunner: {}", msg);
            let _ = self.report_tx.send(msg).await;
            return;
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    fn persist(&self, goal: &Goal) {
        if let Err(e) = self.store.save(goal) {
            warn!("GoalRunner: failed to persist goal: {e}");
        }
    }

    async fn fail(&self, goal: &mut Goal, reason: &str) {
        goal.status = GoalStatus::Failed {
            reason: reason.to_string(),
        };
        goal.touch();
        self.persist(goal);
        let msg = format!("❌ Goal 실패: {}", reason);
        error!("GoalRunner: {}", msg);
        let _ = self.report_tx.send(msg).await;
    }
}
