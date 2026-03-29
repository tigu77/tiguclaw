//! Message handler — LLM chat loop with tool execution and cancellation support.
//!
//! Extracted from `loop_.rs` so the main run loop stays lean and non-blocking.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{debug, info, warn};

use tiguclaw_core::channel::Channel;
use tiguclaw_core::event::DashboardEvent;
use tiguclaw_core::provider::{Provider, ToolDefinition};
use tiguclaw_core::tool::Tool;
use tiguclaw_core::types::*;
use crate::approval::ApprovalManager;
use crate::cancel::CancellationToken;

/// Estimate token count for a slice of messages (total chars / 4).
fn estimate_tokens(messages: &[ChatMessage]) -> usize {
    messages.iter().map(|m| m.content.len()).sum::<usize>() / 4
}

/// Result of processing a single message through the agentic loop.
#[derive(Debug)]
pub enum HandleResult {
    /// Final text reply (already sent to channel).
    Done,
    /// The task was cancelled before completion.
    Cancelled,
}

/// Action sent to the persistence queue.
#[derive(Debug)]
pub enum PersistAction {
    /// Save a single message.
    Save(String, ChatMessage),
    /// Clear all stored messages for the chat, then save the given summary.
    /// Used after context compaction to ensure DB reflects compacted history.
    ClearAndSave(String, ChatMessage),
}

/// Shared state that the spawned handler task needs.
///
/// Wrapped in `Arc` so it can be moved into `tokio::spawn`.
/// Note: `ConversationStore` is not `Send`, so persistence is handled
/// externally via the `persisted` channel.
pub struct HandlerContext {
    pub channel: Arc<dyn Channel>,
    pub provider: Arc<dyn Provider>,
    pub tools: Vec<Arc<dyn Tool>>,
    pub system_prompt: String,
    pub history: Arc<Mutex<Vec<ChatMessage>>>,
    pub max_history: usize,
    /// Channel to send persistence actions.
    /// The main loop drains this and writes to ConversationStore.
    pub persist_tx: mpsc::UnboundedSender<PersistAction>,
    /// Token threshold for context compaction (0 = disabled).
    pub compaction_threshold: usize,
    /// Maximum characters for a single tool result (0 = unlimited).
    pub max_tool_result_chars: usize,
    /// Accumulated cache read tokens (shared with AgentLoop).
    pub cache_read_tokens: Arc<AtomicU64>,
    /// Accumulated cache write tokens (shared with AgentLoop).
    pub cache_write_tokens: Arc<AtomicU64>,
    /// Number of context compactions performed (shared with AgentLoop).
    pub compaction_count: Arc<AtomicU64>,
    /// Optional approval manager for security policy enforcement.
    pub approval_manager: Option<Arc<ApprovalManager>>,
    /// 이 핸들러를 소유한 에이전트 이름 (상태 이벤트 broadcast용).
    pub agent_name: String,
    /// 대시보드 broadcast sender (None이면 비활성화).
    pub event_tx: Option<broadcast::Sender<DashboardEvent>>,
    /// Phase 9-4: 이 태스크에 주입할 steer 지시문 목록.
    /// 다음 LLM 호출 시 system 메시지로 앞에 주입된다.
    pub steer_directives: Vec<String>,
    /// 세션 메타데이터 (시간, 발신자, 채널 등) — user_text 앞에 주입된다.
    /// heartbeat/cron/IPC 메시지는 None.
    pub session_meta: Option<String>,
    /// 마지막 API 호출 시각 (cache-ttl pruning용).
    /// 이 시각으로부터 cache_ttl_secs 이상 지난 경우 오래된 tool_result를 truncate한다.
    pub last_api_call: Arc<Mutex<Option<Instant>>>,
    /// Anthropic 프롬프트 캐시 TTL (초). 0이면 비활성화.
    pub cache_ttl_secs: u64,
}

/// Process a single user message through the agentic loop (LLM + tool calls).
///
/// This function is designed to run inside `tokio::spawn`. It checks
/// `cancel_token` between iterations so the caller can abort cooperatively.
pub async fn handle_message(
    ctx: Arc<HandlerContext>,
    chat_id: String,
    user_text: String,
    cancel_token: CancellationToken,
) -> anyhow::Result<HandleResult> {
    // Phase 9-4: steer 지시문이 있으면 user_text 앞에 주입.
    let user_text = if !ctx.steer_directives.is_empty() {
        let steer_block = ctx
            .steer_directives
            .iter()
            .map(|d| format!("[STEER DIRECTIVE] {d}"))
            .collect::<Vec<_>>()
            .join("\n");
        info!(
            count = ctx.steer_directives.len(),
            "injecting steer directives before user message"
        );
        format!("{steer_block}\n\n{user_text}")
    } else {
        user_text
    };

    // 세션 메타데이터 주입 (T0 실제 사용자 메시지에만).
    let user_text = if let Some(ref meta) = ctx.session_meta {
        debug!("injecting session metadata before user message");
        format!("{meta}\n\n{user_text}")
    } else {
        user_text
    };

    // Add user message to history.
    let user_msg = ChatMessage::user(&user_text);
    persist_message(&ctx, &chat_id, &user_msg);
    {
        let mut history = ctx.history.lock().await;
        history.push(user_msg);
        trim_history(&mut history, ctx.max_history);
    }

    // Compact history if token estimate exceeds threshold.
    maybe_compact_history(&ctx, &chat_id).await?;

    // Prune old tool results if cache TTL has expired (to save context tokens
    // and avoid re-paying cache-miss costs after a long idle period).
    {
        let should_prune = if ctx.cache_ttl_secs > 0 {
            let last = ctx.last_api_call.lock().await;
            last.map(|t| t.elapsed().as_secs() >= ctx.cache_ttl_secs)
                .unwrap_or(false)
        } else {
            false
        };

        if should_prune {
            debug!(
                cache_ttl_secs = ctx.cache_ttl_secs,
                "cache TTL expired — pruning old tool results"
            );
            let mut history = ctx.history.lock().await;
            prune_old_tool_results(&mut history);
            // Sanitize after pruning: prune_old_tool_results only truncates content,
            // but trim_history (called above) may have removed assistant messages while
            // leaving their tool_results, producing orphan tool_result blocks.
            sanitize_history(&mut history);
        } else {
            // Still sanitize history even without pruning.
            let mut history = ctx.history.lock().await;
            sanitize_history(&mut history);
        }
    }

    // Build tool definitions.
    let tool_defs = tool_definitions(&ctx.tools);

    // Agentic loop: call provider, handle tool calls, repeat.
    // Runs until no tool calls remain (context limit is the only bound).
    let mut iteration = 0usize;
    loop {
        // ── Cancellation check ──
        if cancel_token.is_cancelled() {
            info!(iteration, "handle_message cancelled before provider call");
            if let Some(ref tx) = ctx.event_tx {
                let _ = tx.send(DashboardEvent::AgentIdle { name: ctx.agent_name.clone() });
            }
            return Ok(HandleResult::Cancelled);
        }

        // Build request messages (system + history snapshot).
        // Sanitize first to remove orphan tool_result / incomplete tool_call sequences
        // that would cause a 400 invalid_request_error from the Anthropic API.
        let request_messages = {
            let mut history = ctx.history.lock().await;
            sanitize_history(&mut history);
            let mut msgs = Vec::with_capacity(history.len() + 1);
            msgs.push(ChatMessage::system(&ctx.system_prompt));
            msgs.extend(history.iter().cloned());
            msgs
        };

        debug!(iteration, "calling provider");

        // Refresh typing indicator each iteration.
        if iteration > 0 {
            let _ = ctx.channel.send_typing(&chat_id).await;
        }

        // 상태 이벤트: LLM 호출 직전 → AgentThinking.
        if let Some(ref tx) = ctx.event_tx {
            let _ = tx.send(DashboardEvent::AgentThinking { name: ctx.agent_name.clone() });
        }

        let response = ctx
            .provider
            .chat(&request_messages, &tool_defs)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;

        // ── Cancellation check after await ──
        if cancel_token.is_cancelled() {
            info!(iteration, "handle_message cancelled after provider call");
            return Ok(HandleResult::Cancelled);
        }

        // Update last_api_call timestamp for cache-TTL pruning.
        if ctx.cache_ttl_secs > 0 {
            let mut last = ctx.last_api_call.lock().await;
            *last = Some(Instant::now());
        }

        debug!(
            text_len = response.text.len(),
            tool_calls = response.tool_calls.len(),
            "provider response"
        );

        // Accumulate cache token statistics.
        ctx.cache_read_tokens.fetch_add(response.usage.cache_read_tokens as u64, Ordering::Relaxed);
        ctx.cache_write_tokens.fetch_add(response.usage.cache_write_tokens as u64, Ordering::Relaxed);

        if response.tool_calls.is_empty() {
            // Final text response.
            if !response.text.is_empty() {
                let assistant_msg = ChatMessage::assistant(&response.text);
                persist_message(&ctx, &chat_id, &assistant_msg);
                {
                    let mut history = ctx.history.lock().await;
                    history.push(assistant_msg);
                }

                ctx.channel
                    .send(&chat_id, &response.text)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
            }
            // 상태 이벤트: 처리 완료 → AgentIdle.
            if let Some(ref tx) = ctx.event_tx {
                let _ = tx.send(DashboardEvent::AgentIdle { name: ctx.agent_name.clone() });
            }
            return Ok(HandleResult::Done);
        }

        // Store assistant message with tool calls in history (for LLM context),
        // but do NOT persist to DB — text is empty during tool calls and would
        // appear as blank messages in the dashboard conversation view.
        let assistant_msg =
            ChatMessage::assistant_with_tools(&response.text, response.tool_calls.clone());
        {
            let mut history = ctx.history.lock().await;
            history.push(assistant_msg);
        }

        // Execute each tool call.
        for tc in &response.tool_calls {
            if cancel_token.is_cancelled() {
                info!(tool = %tc.name, "cancelled before tool execution");
                return Ok(HandleResult::Cancelled);
            }

            // ── Security policy check ──
            if let Some(ref approval_mgr) = ctx.approval_manager {
                let args_summary = format_args_summary(&tc.args);
                match approval_mgr.check(&tc.name, &args_summary).await {
                    Ok(true) => {
                        // Approved — proceed with execution.
                    }
                    Ok(false) => {
                        // Denied by admin.
                        let msg = format!("🚫 '{}' 실행이 거부되었습니다.", tc.name);
                        warn!(tool = %tc.name, "tool execution denied by admin");
                        let tool_msg = ChatMessage::tool_result(&tc.id, &msg);
                        persist_message(&ctx, &chat_id, &tool_msg);
                        {
                            let mut history = ctx.history.lock().await;
                            history.push(tool_msg);
                        }
                        continue;
                    }
                    Err(e) => {
                        // Timed out or error → auto-deny.
                        let msg = format!(
                            "🚫 '{}' 실행이 거부되었습니다 (타임아웃/오류: {}).",
                            tc.name, e
                        );
                        warn!(tool = %tc.name, error = %e, "tool execution auto-denied (timeout/error)");
                        let tool_msg = ChatMessage::tool_result(&tc.id, &msg);
                        persist_message(&ctx, &chat_id, &tool_msg);
                        {
                            let mut history = ctx.history.lock().await;
                            history.push(tool_msg);
                        }
                        continue;
                    }
                }
            }

            info!(tool = %tc.name, id = %tc.id, "executing tool");
            // 상태 이벤트: 툴 실행 직전 → AgentExecuting.
            if let Some(ref tx) = ctx.event_tx {
                let _ = tx.send(DashboardEvent::AgentExecuting {
                    name: ctx.agent_name.clone(),
                    tool: tc.name.clone(),
                });
            }
            let result = execute_tool(&ctx.tools, tc).await;
            debug!(tool = %tc.name, result_len = result.len(), "tool result");

            // Truncate large tool results to prevent context explosion.
            let result = if ctx.max_tool_result_chars > 0 && result.len() > ctx.max_tool_result_chars {
                let truncated = &result[..ctx.max_tool_result_chars];
                // 멀티바이트 문자 경계 안전 처리
                let safe = truncated.char_indices().last()
                    .map(|(i, c)| &result[..i + c.len_utf8()])
                    .unwrap_or(truncated);
                let safe_len = safe.len();
                let total_len = result.len();
                warn!(tool = %tc.name, total_len, safe_len, "tool result truncated");
                format!("{}\n\n[... truncated: {} chars total, showing first {} chars]",
                    safe, total_len, safe_len)
            } else {
                result
            };

            let tool_msg = ChatMessage::tool_result(&tc.id, &result);
            persist_message(&ctx, &chat_id, &tool_msg);
            {
                let mut history = ctx.history.lock().await;
                history.push(tool_msg);
            }
        }

        // Continue loop to get next provider response.
        iteration += 1;
    }
}

/// Execute a tool call, returning the result string.
async fn execute_tool(tools: &[Arc<dyn Tool>], tc: &ToolCall) -> String {
    let tool = tools.iter().find(|t| t.name() == tc.name);
    match tool {
        Some(tool) => match tool.execute(&tc.args).await {
            Ok(result) => result,
            Err(e) => format!("Tool error: {e}"),
        },
        None => format!("Unknown tool: {}", tc.name),
    }
}

/// Summarize tool arguments as a compact string for approval messages.
/// Limits output to 500 characters to keep Telegram messages readable.
fn format_args_summary(args: &std::collections::HashMap<String, serde_json::Value>) -> String {
    let raw = serde_json::to_string(args).unwrap_or_else(|_| "{...}".to_string());
    if raw.len() > 500 {
        format!("{}…", &raw[..500])
    } else {
        raw
    }
}

/// Build ToolDefinition list from registered tools.
fn tool_definitions(tools: &[Arc<dyn Tool>]) -> Vec<ToolDefinition> {
    tools
        .iter()
        .map(|t| ToolDefinition {
            name: t.name().to_string(),
            description: t.description().to_string(),
            input_schema: t.schema(),
        })
        .collect()
}

/// Queue a message for persistence (drained by main loop).
///
/// conversation key = agent_name (비어 있으면 chat_id 폴백).
/// 이렇게 하면 텔레그램/대시보드 등 채널이 달라도 같은 에이전트면 단일 대화 스트림에 저장된다.
fn persist_message(ctx: &HandlerContext, chat_id: &str, message: &ChatMessage) {
    let conv_id = if !ctx.agent_name.is_empty() {
        ctx.agent_name.clone()
    } else {
        chat_id.to_string()
    };
    let _ = ctx.persist_tx.send(PersistAction::Save(conv_id, message.clone()));
}

/// Queue a compaction: clear DB history and save only the summary message.
fn persist_compaction(ctx: &HandlerContext, chat_id: &str, summary_msg: &ChatMessage) {
    let conv_id = if !ctx.agent_name.is_empty() {
        ctx.agent_name.clone()
    } else {
        chat_id.to_string()
    };
    let _ = ctx
        .persist_tx
        .send(PersistAction::ClearAndSave(conv_id, summary_msg.clone()));
}

/// Trim history (public helper for tests).
pub fn trim_history_pub(history: &mut Vec<ChatMessage>, max_history: usize) {
    trim_history(history, max_history);
}

/// Remove orphan tool_result messages and incomplete tool_call sequences from history.
///
/// Anthropic API requires:
/// 1. Every `tool_result` must have a corresponding `tool_use` in an assistant message.
/// 2. Every `tool_use` in an assistant message must have a corresponding `tool_result`.
///
/// Violations happen when:
/// - `trim_history` removes an assistant_with_tools but keeps its tool_results.
/// - Cancellation/timeout interrupts tool execution after the assistant message was added
///   but before all tool_results were appended.
pub fn sanitize_history(history: &mut Vec<ChatMessage>) {
    use std::collections::HashSet;

    // Collect all tool_result IDs present in history.
    let result_ids: HashSet<String> = history
        .iter()
        .filter(|m| m.role == Role::Tool)
        .filter_map(|m| m.tool_call_id.clone())
        .collect();

    // Collect all tool_call IDs referenced in assistant messages.
    let all_call_ids: HashSet<String> = history
        .iter()
        .filter(|m| m.role == Role::Assistant)
        .flat_map(|m| m.tool_calls.iter().map(|tc| tc.id.clone()))
        .collect();

    // Build the set of "complete" tool_call IDs: assistant messages where ALL
    // tool_calls have matching tool_results.
    let complete_call_ids: HashSet<String> = history
        .iter()
        .filter(|m| m.role == Role::Assistant && !m.tool_calls.is_empty())
        .filter(|m| m.tool_calls.iter().all(|tc| result_ids.contains(&tc.id)))
        .flat_map(|m| m.tool_calls.iter().map(|tc| tc.id.clone()))
        .collect();

    // Quick exit: no tool messages at all → nothing to sanitize.
    if result_ids.is_empty() && all_call_ids.is_empty() {
        return;
    }

    // Check whether anything is actually wrong before doing the retain.
    let needs_sanitize = history.iter().any(|m| match m.role {
        // Orphan tool_result: tool_call_id not present in any assistant message.
        Role::Tool => m
            .tool_call_id
            .as_ref()
            .map_or(true, |id| !all_call_ids.contains(id) || !complete_call_ids.contains(id)),
        // Incomplete assistant message: some tool_calls have no result.
        Role::Assistant if !m.tool_calls.is_empty() => {
            !m.tool_calls.iter().all(|tc| result_ids.contains(&tc.id))
        }
        _ => false,
    });

    if !needs_sanitize {
        return;
    }

    let original_len = history.len();
    history.retain(|msg| match msg.role {
        // Keep tool_results only if they belong to a complete assistant message.
        Role::Tool => msg
            .tool_call_id
            .as_ref()
            .map_or(false, |id| complete_call_ids.contains(id)),
        // Keep assistant messages only if ALL their tool_calls have results.
        Role::Assistant if !msg.tool_calls.is_empty() => {
            msg.tool_calls.iter().all(|tc| result_ids.contains(&tc.id))
        }
        // Keep everything else unchanged.
        _ => true,
    });

    let removed = original_len - history.len();
    if removed > 0 {
        warn!(
            removed,
            "sanitize_history: removed orphan/incomplete tool_call sequences"
        );
    }
}

/// Compact history via LLM summarization when token estimate exceeds threshold.
///
/// If the threshold is 0 (disabled) or not exceeded, returns immediately.
/// On success, replaces history with a single summary message.
async fn maybe_compact_history(
    ctx: &HandlerContext,
    chat_id: &str,
) -> anyhow::Result<()> {
    let threshold = ctx.compaction_threshold;
    if threshold == 0 {
        return Ok(());
    }

    let needs_compact = {
        let history = ctx.history.lock().await;
        estimate_tokens(&history) > threshold
    };

    if !needs_compact {
        return Ok(());
    }

    info!(threshold, "history exceeds compaction threshold — summarizing");

    // Build a plain-text representation of the conversation history.
    let history_text = {
        let history = ctx.history.lock().await;
        history
            .iter()
            .map(|m| format!("[{:?}]: {}", m.role, m.content))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let summary_prompt = format!(
        "다음 대화를 핵심 정보만 유지하며 간결하게 요약해줘. \
        중요한 결정, 코드, 파일 경로, 작업 결과는 반드시 포함할 것.\n\n{history_text}"
    );

    let summary_messages = vec![ChatMessage::user(summary_prompt)];
    let summary_response = ctx
        .provider
        .chat(&summary_messages, &[])
        .await
        .map_err(|e| anyhow::anyhow!("compaction summary request failed: {e}"))?;

    let summary = summary_response.text;
    if summary.is_empty() {
        warn!("compaction returned empty summary — skipping");
        return Ok(());
    }

    // Replace history with the summary message.
    let summary_msg = ChatMessage::user(format!("이전 대화 요약:\n{summary}"));
    // Persist compaction: clear DB history and save only the summary.
    persist_compaction(ctx, chat_id, &summary_msg);
    {
        let mut history = ctx.history.lock().await;
        history.clear();
        history.push(summary_msg);
    }

    ctx.compaction_count.fetch_add(1, Ordering::Relaxed);
    info!("history compacted to summary");
    Ok(())
}

/// Trim history to max_history, keeping the most recent messages.
fn trim_history(history: &mut Vec<ChatMessage>, max_history: usize) {
    if history.len() > max_history {
        let drain_count = history.len() - max_history;
        history.drain(0..drain_count);
        debug!(
            removed = drain_count,
            remaining = history.len(),
            "trimmed history"
        );
    }
}

/// Number of recent "turns" (assistant messages) whose tool results are preserved.
const PRUNE_KEEP_RECENT_TURNS: usize = 8;

/// Truncate tool_result contents in old turns to save context tokens.
///
/// Counts assistant messages as "turns". Tool results more than
/// `PRUNE_KEEP_RECENT_TURNS` assistant turns back are replaced with
/// `[tool result truncated]`.
pub fn prune_old_tool_results(history: &mut Vec<ChatMessage>) {
    // Count assistant messages from the end to find the cutoff index.
    let mut assistant_count = 0usize;
    let mut cutoff_idx = history.len(); // all messages start preserved

    for (i, msg) in history.iter().enumerate().rev() {
        if msg.role == Role::Assistant {
            assistant_count += 1;
            if assistant_count >= PRUNE_KEEP_RECENT_TURNS {
                cutoff_idx = i;
                break;
            }
        }
    }

    if cutoff_idx == history.len() {
        return; // not enough turns to prune
    }

    let mut pruned = 0usize;
    for msg in history[..cutoff_idx].iter_mut() {
        if msg.role == Role::Tool && msg.content != "[tool result truncated]" {
            msg.content = "[tool result truncated]".to_string();
            pruned += 1;
        }
    }

    if pruned > 0 {
        debug!(pruned, cutoff_idx, "pruned old tool results");
    }
}
