use serde::{Deserialize, Serialize};

// ─── PhaseStatus ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data")]
pub enum PhaseStatus {
    Pending,
    Running,
    Completed,
    Failed { reason: String },
}

impl Default for PhaseStatus {
    fn default() -> Self {
        PhaseStatus::Pending
    }
}

// ─── Phase ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phase {
    pub id: String,
    pub description: String,
    pub status: PhaseStatus,
    pub result: Option<String>,
}

impl Phase {
    pub fn new(description: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            description: description.into(),
            status: PhaseStatus::Pending,
            result: None,
        }
    }

    pub fn is_done(&self) -> bool {
        matches!(
            self.status,
            PhaseStatus::Completed | PhaseStatus::Failed { .. }
        )
    }
}

// ─── GoalStatus ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data")]
pub enum GoalStatus {
    Pending,
    Planning,
    Executing { current_phase: usize },
    Completed,
    Failed { reason: String },
    Replanning { feedback: String },
}

impl Default for GoalStatus {
    fn default() -> Self {
        GoalStatus::Pending
    }
}

impl GoalStatus {
    /// 활성 상태인지 여부 (Pending 또는 Executing)
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            GoalStatus::Pending
                | GoalStatus::Planning
                | GoalStatus::Executing { .. }
                | GoalStatus::Replanning { .. }
        )
    }

    /// 종료 상태인지 여부
    pub fn is_terminal(&self) -> bool {
        matches!(self, GoalStatus::Completed | GoalStatus::Failed { .. })
    }
}

// ─── Goal ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Goal {
    pub id: String,
    pub description: String,
    pub status: GoalStatus,
    pub phases: Vec<Phase>,
    pub attempt: u32,
    pub max_attempts: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Goal {
    /// 새 Goal 생성 (기본 max_attempts = 3)
    pub fn new(description: impl Into<String>) -> Self {
        let now = chrono::Utc::now().timestamp();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            description: description.into(),
            status: GoalStatus::Pending,
            phases: Vec::new(),
            attempt: 0,
            max_attempts: 3,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn with_max_attempts(mut self, max: u32) -> Self {
        self.max_attempts = max;
        self
    }

    /// 재시도 가능 여부
    pub fn can_retry(&self) -> bool {
        self.attempt < self.max_attempts
    }

    /// 현재 실행 중인 Phase 인덱스
    pub fn current_phase_index(&self) -> Option<usize> {
        if let GoalStatus::Executing { current_phase } = self.status {
            Some(current_phase)
        } else {
            None
        }
    }

    /// updated_at 타임스탬프 갱신
    pub fn touch(&mut self) {
        self.updated_at = chrono::Utc::now().timestamp();
    }
}
