//! tiguclaw-planner — LLM 기반 Goal → Phase 분해 및 검증 크레이트.
//!
//! # 주요 컴포넌트
//! - [`LlmPlanner`]: Goal 설명을 받아 실행 가능한 Phase 목록으로 분해
//! - [`LlmValidator`]: Phase 실행 결과가 목표를 달성했는지 검증

pub mod planner;
pub mod validator;

pub use planner::LlmPlanner;
pub use validator::{LlmValidator, ValidationResult};
