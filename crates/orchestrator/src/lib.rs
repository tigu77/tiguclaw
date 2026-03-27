//! tiguclaw-orchestrator — Goal 자율 피드백 루프 크레이트.
//!
//! # 주요 컴포넌트
//! - [`GoalRunner`]: plan → execute → validate 루프 실행
//! - [`PhaseExecutor`]: Phase를 실행하고 결과를 반환

pub mod executor;
pub mod goal_runner;

pub use executor::PhaseExecutor;
pub use goal_runner::GoalRunner;
