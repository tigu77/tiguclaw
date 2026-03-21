//! analyze_workload 툴 — 슈퍼마스터 자율 spawn 판단 도구.
//!
//! Phase 8-1: 슈퍼마스터가 현재 상황을 보고 에이전트 spawn 필요 여부를 판단한다.
//! `auto_spawn.enabled = false`이면 즉시 bypass 결과를 반환한다.

use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use tiguclaw_core::error::{Result, TiguError};
use tiguclaw_core::tool::Tool;

use crate::registry::AgentRegistry;

/// 현재 작업 부하를 분석하여 에이전트 spawn 필요 여부를 판단하는 툴.
///
/// # Input
/// ```json
/// {
///   "context": "현재 상황 설명 (작업 목록, 부하 등)"
/// }
/// ```
///
/// # Output
/// ```json
/// {
///   "should_spawn": true,
///   "recommended_agents": [
///     {
///       "name": "code-helper",
///       "role": "코딩 전담",
///       "reason": "리팩토링 작업이 장시간 소요되어 응답성 확보 필요"
///     }
///   ],
///   "current_agent_count": 1,
///   "auto_spawn_enabled": true
/// }
/// ```
pub struct AnalyzeWorkloadTool {
    registry: Arc<Mutex<AgentRegistry>>,
    /// 자율 spawn 활성화 여부 (config에서 주입).
    auto_spawn_enabled: bool,
    /// 최대 자율 spawn 에이전트 수.
    max_auto_agents: u8,
}

impl AnalyzeWorkloadTool {
    pub fn new(
        registry: Arc<Mutex<AgentRegistry>>,
        auto_spawn_enabled: bool,
        max_auto_agents: u8,
    ) -> Self {
        Self {
            registry,
            auto_spawn_enabled,
            max_auto_agents,
        }
    }
}

#[async_trait]
impl Tool for AnalyzeWorkloadTool {
    fn name(&self) -> &str {
        "analyze_workload"
    }

    fn description(&self) -> &str {
        "현재 작업 부하를 분석하여 에이전트 spawn 필요 여부를 판단합니다. \
         auto_spawn이 활성화된 경우 슈퍼마스터가 자율적으로 에이전트를 생성할 때 \
         이 툴로 먼저 판단한 후 spawn_agent를 호출하세요. \
         결과: { should_spawn, recommended_agents, current_agent_count, auto_spawn_enabled }"
    }

    fn schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "context": {
                    "type": "string",
                    "description": "현재 상황 설명: 진행 중인 작업, 예상 소요 시간, 병렬 처리 필요성 등"
                }
            },
            "required": ["context"]
        })
    }

    async fn execute(
        &self,
        args: &HashMap<String, serde_json::Value>,
    ) -> Result<String> {
        let context = args
            .get("context")
            .and_then(|v| v.as_str())
            .ok_or_else(|| TiguError::Tool("'context' 파라미터가 필요합니다".into()))?;

        // auto_spawn 비활성화 시 즉시 bypass
        if !self.auto_spawn_enabled {
            let result = json!({
                "should_spawn": false,
                "recommended_agents": [],
                "current_agent_count": 0,
                "auto_spawn_enabled": false,
                "reason": "auto_spawn이 비활성화되어 있습니다. config.toml의 [auto_spawn] enabled = true로 활성화하세요."
            });
            return Ok(result.to_string());
        }

        // 현재 에이전트 수 조회
        let current_agents = {
            let registry = self.registry.lock().await;
            registry.list()
        };
        let current_count = current_agents.len();

        // 최대 에이전트 수 초과 시 spawn 불가
        if current_count >= self.max_auto_agents as usize {
            let result = json!({
                "should_spawn": false,
                "recommended_agents": [],
                "current_agent_count": current_count,
                "auto_spawn_enabled": true,
                "reason": format!(
                    "현재 에이전트 수({})가 최대값({})에 도달했습니다. 기존 에이전트를 종료한 후 시도하세요.",
                    current_count, self.max_auto_agents
                )
            });
            return Ok(result.to_string());
        }

        // 컨텍스트 기반 spawn 필요 여부 휴리스틱 분석
        let (should_spawn, recommended_agents) = analyze_context(context, current_count, self.max_auto_agents);

        let result = json!({
            "should_spawn": should_spawn,
            "recommended_agents": recommended_agents,
            "current_agent_count": current_count,
            "auto_spawn_enabled": true,
            "available_slots": (self.max_auto_agents as usize).saturating_sub(current_count)
        });

        Ok(result.to_string())
    }
}

/// 컨텍스트를 분석하여 spawn 필요 여부와 추천 에이전트 목록을 반환.
///
/// 휴리스틱 규칙 기반으로 판단:
/// 1. 병렬 작업 키워드 감지 (연구 + 코딩, 동시에, 병렬, parallel 등)
/// 2. 장시간 작업 키워드 감지 (오래 걸림, 시간이 걸림, long-running 등)
/// 3. 반복 작업 키워드 감지 (매번, 계속, 반복적으로 등)
fn analyze_context(
    context: &str,
    current_count: usize,
    max_agents: u8,
) -> (bool, Vec<serde_json::Value>) {
    let ctx_lower = context.to_lowercase();
    let available_slots = (max_agents as usize).saturating_sub(current_count);

    if available_slots == 0 {
        return (false, vec![]);
    }

    let mut recommendations: Vec<serde_json::Value> = Vec::new();

    // 병렬 작업 필요 시그널
    let parallel_keywords = [
        "동시에", "병렬", "parallel", "동시", "함께",
        "연구 + 코딩", "research + coding", "조사하면서",
    ];
    let parallel_needed = parallel_keywords.iter().any(|kw| ctx_lower.contains(kw));

    // 장시간 작업 시그널
    let long_running_keywords = [
        "오래 걸", "시간이 걸", "long-running", "장시간",
        "느리", "블로킹", "blocking", "기다려야",
    ];
    let long_running = long_running_keywords.iter().any(|kw| ctx_lower.contains(kw));

    // 반복 작업 시그널
    let repeated_keywords = [
        "반복", "매번", "계속해서", "repeatedly", "자주",
        "주기적", "periodic",
    ];
    let repeated_task = repeated_keywords.iter().any(|kw| ctx_lower.contains(kw));

    // 코딩 전담 에이전트 추천
    let coding_keywords = ["코드", "코딩", "리팩토링", "개발", "code", "coding", "refactor", "build"];
    let needs_coder = coding_keywords.iter().any(|kw| ctx_lower.contains(kw));

    // 연구/검색 전담 에이전트 추천
    let research_keywords = ["검색", "조사", "리서치", "research", "찾아", "분석", "analyze"];
    let needs_researcher = research_keywords.iter().any(|kw| ctx_lower.contains(kw));

    let should_spawn = parallel_needed || long_running || repeated_task;

    if should_spawn {
        if needs_coder && recommendations.len() < available_slots {
            recommendations.push(json!({
                "name": "code-helper",
                "level": 2,
                "role": "코딩 전담 에이전트. 리팩토링, 코드 리뷰, 빌드 태스크를 담당한다.",
                "persistent": false,
                "reason": "코딩/개발 작업을 병렬로 처리하기 위해 추천"
            }));
        }

        if needs_researcher && recommendations.len() < available_slots {
            recommendations.push(json!({
                "name": "research-helper",
                "level": 2,
                "role": "검색/조사 전담 에이전트. 웹 검색, 문서 수집, 정보 분석을 담당한다.",
                "persistent": false,
                "reason": "연구/검색 작업을 병렬로 처리하기 위해 추천"
            }));
        }

        // 일반 워커 추천 (특정 타입 미지정 시)
        if recommendations.is_empty() && available_slots > 0 {
            let reason = if long_running {
                "장시간 작업으로 인한 응답성 확보 필요"
            } else if parallel_needed {
                "병렬 처리로 효율성 향상 가능"
            } else {
                "반복 작업 전담 처리"
            };

            recommendations.push(json!({
                "name": "task-worker",
                "level": 2,
                "role": "범용 태스크 워커. 위임된 작업을 독립적으로 처리한다.",
                "persistent": false,
                "reason": reason
            }));
        }
    }

    (should_spawn, recommendations)
}
