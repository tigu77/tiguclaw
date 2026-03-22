//! Unit tests for AgentLoop — extracted from `loop_.rs`.

use super::AgentLoop;
use crate::context_commands::ContextCommand;
use crate::message_handler::trim_history_pub;

use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use async_trait::async_trait;
use tokio::sync::mpsc;

use tiguclaw_core::channel::Channel;
use tiguclaw_core::error::Result;
use tiguclaw_core::provider::Provider;
use tiguclaw_core::provider::ToolDefinition;
use tiguclaw_core::types::*;
use tiguclaw_memory::SqliteMemory;

/// Dummy channel that immediately sends one message then closes.
struct DummyChannel {
    sent: Arc<StdMutex<Vec<String>>>,
}

impl DummyChannel {
    fn new() -> Self {
        Self {
            sent: Arc::new(StdMutex::new(Vec::new())),
        }
    }

    fn sent_messages(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait]
impl Channel for DummyChannel {
    fn name(&self) -> &str {
        "dummy"
    }

    async fn send(&self, _chat_id: &str, text: &str) -> Result<()> {
        self.sent.lock().unwrap().push(text.to_string());
        Ok(())
    }

    async fn listen(&self, tx: mpsc::Sender<ChannelMessage>) -> Result<()> {
        let msg = ChannelMessage {
            id: "1".into(),
            sender: "test_user".into(),
            content: "hello".into(),
            timestamp: 0,
            source: None,
        };
        let _ = tx.send(msg).await;
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        Ok(())
    }
}

/// Dummy provider that returns a fixed response.
struct DummyProvider {
    response: ChatResponse,
}

impl DummyProvider {
    fn text_only(text: &str) -> Self {
        Self {
            response: ChatResponse {
                text: text.to_string(),
                tool_calls: Vec::new(),
                usage: Usage::default(),
            },
        }
    }
}

#[async_trait]
impl Provider for DummyProvider {
    fn name(&self) -> &str {
        "dummy"
    }

    async fn chat(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolDefinition],
    ) -> Result<ChatResponse> {
        Ok(self.response.clone())
    }
}

#[tokio::test]
async fn test_simple_text_response() {
    let channel = Arc::new(DummyChannel::new());
    let provider = Arc::new(DummyProvider::text_only("Hello back!"));

    let mut agent = AgentLoop::new(
        channel.clone(),
        provider,
        Vec::new(),
        "You are a test bot.".into(),
        50,
        None,
    );

    agent.run().await.unwrap();

    let sent = channel.sent_messages();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0], "Hello back!");
}

#[tokio::test]
async fn test_tool_call_loop() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use serde_json::json;

    let call_count = Arc::new(AtomicUsize::new(0));
    let call_count_clone = call_count.clone();

    /// Provider that returns a tool call on first call, text on second.
    struct ToolThenTextProvider {
        call_count: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Provider for ToolThenTextProvider {
        fn name(&self) -> &str {
            "tool-then-text"
        }

        async fn chat(
            &self,
            _messages: &[ChatMessage],
            _tools: &[ToolDefinition],
        ) -> Result<ChatResponse> {
            let n = self.call_count.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                Ok(ChatResponse {
                    text: String::new(),
                    tool_calls: vec![ToolCall {
                        id: "tc_1".into(),
                        name: "shell".into(),
                        args: [("command".into(), json!("echo hi"))].into(),
                    }],
                    usage: Usage::default(),
                })
            } else {
                Ok(ChatResponse {
                    text: "Done! Output was: hi".into(),
                    tool_calls: Vec::new(),
                    usage: Usage::default(),
                })
            }
        }
    }

    let channel = Arc::new(DummyChannel::new());
    let provider = Arc::new(ToolThenTextProvider {
        call_count: call_count_clone,
    });

    let runtime = Arc::new(tiguclaw_runtime::DummyRuntime::with_output("hi", 0));
    let shell_tool = crate::tools::ShellTool::new(runtime);

    let mut agent = AgentLoop::new(
        channel.clone(),
        provider,
        vec![Box::new(shell_tool)],
        "test".into(),
        50,
        None,
    );

    agent.run().await.unwrap();

    let sent = channel.sent_messages();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].contains("Done!"));
    assert_eq!(call_count.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn test_trim_history() {
    let channel = Arc::new(DummyChannel::new());
    let provider = Arc::new(DummyProvider::text_only("ok"));

    let agent = AgentLoop::new(
        channel,
        provider,
        Vec::new(),
        "test".into(),
        3, // max 3 messages
        None,
    );

    // Add 5 messages.
    {
        let mut history = agent.history.lock().await;
        for i in 0..5 {
            history.push(ChatMessage::user(format!("msg {i}")));
        }
    }
    // Trigger trim via message_handler helper
    {
        let mut history = agent.history.lock().await;
        trim_history_pub(&mut history, 3);
    }
    let history = agent.history.lock().await;
    assert_eq!(history.len(), 3);
    assert_eq!(history[0].content, "msg 2");
}

/// Helper: DummyChannel that sends a specific message.
struct CommandChannel {
    command: String,
    sent: Arc<StdMutex<Vec<String>>>,
}

impl CommandChannel {
    fn new(command: &str) -> Self {
        Self {
            command: command.to_string(),
            sent: Arc::new(StdMutex::new(Vec::new())),
        }
    }

    fn sent_messages(&self) -> Vec<String> {
        self.sent.lock().unwrap().clone()
    }
}

#[async_trait]
impl Channel for CommandChannel {
    fn name(&self) -> &str {
        "command"
    }

    async fn send(&self, _chat_id: &str, text: &str) -> Result<()> {
        self.sent.lock().unwrap().push(text.to_string());
        Ok(())
    }

    async fn listen(&self, tx: mpsc::Sender<ChannelMessage>) -> Result<()> {
        let msg = ChannelMessage {
            id: "1".into(),
            sender: "test_user".into(),
            content: self.command.clone(),
            timestamp: 0,
            source: None,
        };
        let _ = tx.send(msg).await;
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        Ok(())
    }
}

/// Provider that tracks call count to verify commands bypass LLM.
struct CountingProvider {
    call_count: Arc<std::sync::atomic::AtomicUsize>,
}

#[async_trait]
impl Provider for CountingProvider {
    fn name(&self) -> &str {
        "counting"
    }

    async fn chat(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolDefinition],
    ) -> Result<ChatResponse> {
        self.call_count
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(ChatResponse {
            text: "should not be called".into(),
            tool_calls: Vec::new(),
            usage: Usage::default(),
        })
    }
}

fn make_test_context_store() -> Arc<SqliteMemory> {
    Arc::new(SqliteMemory::open(None).unwrap())
}

#[tokio::test]
async fn test_context_save_bypasses_llm() {
    let call_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let channel = Arc::new(CommandChannel::new("/save test-ctx"));
    let provider = Arc::new(CountingProvider {
        call_count: call_count.clone(),
    });
    let store = make_test_context_store();

    let mut agent = AgentLoop::new(
        channel.clone(),
        provider,
        Vec::new(),
        "test".into(),
        50,
        None,
    )
    .with_context_store(store);

    // Add some history before running.
    {
        let mut history = agent.history.lock().await;
        history.push(ChatMessage::user("hello"));
        history.push(ChatMessage::assistant("hi there"));
    }

    agent.run().await.unwrap();

    assert_eq!(
        call_count.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "LLM should not be called for context commands"
    );

    let sent = channel.sent_messages();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].contains("저장 완료"));
    assert!(sent[0].contains("2개 메시지"));
}

#[tokio::test]
async fn test_context_list_empty() {
    let call_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let channel = Arc::new(CommandChannel::new("/list"));
    let provider = Arc::new(CountingProvider {
        call_count: call_count.clone(),
    });
    let store = make_test_context_store();

    let mut agent = AgentLoop::new(
        channel.clone(),
        provider,
        Vec::new(),
        "test".into(),
        50,
        None,
    )
    .with_context_store(store);

    agent.run().await.unwrap();

    assert_eq!(
        call_count.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    let sent = channel.sent_messages();
    assert!(sent[0].contains("저장된 컨텍스트가 없습니다"));
}

#[tokio::test]
async fn test_context_save_and_load() {
    let store = make_test_context_store();

    let channel = Arc::new(DummyChannel::new());
    let provider = Arc::new(DummyProvider::text_only("unused"));
    let mut agent = AgentLoop::new(
        channel.clone(),
        provider,
        Vec::new(),
        "test".into(),
        50,
        None,
    )
    .with_context_store(store.clone());

    {
        let mut history = agent.history.lock().await;
        history.push(ChatMessage::user("question 1"));
        history.push(ChatMessage::assistant("answer 1"));
    }

    // Save context directly via handle_context_command.
    let result = agent
        .handle_context_command(ContextCommand::Save("my-ctx".into()))
        .await;
    assert!(result.contains("저장 완료"));

    // Clear history, then load.
    {
        agent.history.lock().await.clear();
    }

    let result = agent
        .handle_context_command(ContextCommand::Load("my-ctx".into()))
        .await;
    assert!(result.contains("로드 완료"));
    let history = agent.history.lock().await;
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].content, "question 1");
}

#[tokio::test]
async fn test_context_delete() {
    let store = make_test_context_store();
    store
        .save_context(
            "del-me",
            &[serde_json::json!({"role": "user", "content": "hi"})],
        )
        .unwrap();

    let channel = Arc::new(DummyChannel::new());
    let provider = Arc::new(DummyProvider::text_only("unused"));
    let mut agent = AgentLoop::new(
        channel.clone(),
        provider,
        Vec::new(),
        "test".into(),
        50,
        None,
    )
    .with_context_store(store);

    let result = agent
        .handle_context_command(ContextCommand::Delete("del-me".into()))
        .await;
    assert!(result.contains("삭제 완료"));

    let result = agent
        .handle_context_command(ContextCommand::Delete("del-me".into()))
        .await;
    assert!(result.contains("찾을 수 없습니다"));
}

#[tokio::test]
async fn test_context_no_store() {
    let channel = Arc::new(DummyChannel::new());
    let provider = Arc::new(DummyProvider::text_only("unused"));
    let mut agent = AgentLoop::new(
        channel.clone(),
        provider,
        Vec::new(),
        "test".into(),
        50,
        None,
    );
    // No context_store set

    let result = agent
        .handle_context_command(ContextCommand::Save("test".into()))
        .await;
    assert!(result.contains("설정되지 않았습니다"));
}

#[tokio::test]
async fn test_context_load_not_found() {
    let store = make_test_context_store();
    let channel = Arc::new(DummyChannel::new());
    let provider = Arc::new(DummyProvider::text_only("unused"));
    let mut agent = AgentLoop::new(
        channel.clone(),
        provider,
        Vec::new(),
        "test".into(),
        50,
        None,
    )
    .with_context_store(store);

    let result = agent
        .handle_context_command(ContextCommand::Load("nonexistent".into()))
        .await;
    assert!(result.contains("찾을 수 없습니다"));
}

#[tokio::test]
async fn test_cancel_no_active_task() {
    let channel = Arc::new(CommandChannel::new("/cancel"));
    let provider = Arc::new(DummyProvider::text_only("unused"));

    let mut agent = AgentLoop::new(
        channel.clone(),
        provider,
        Vec::new(),
        "test".into(),
        50,
        None,
    );

    agent.run().await.unwrap();

    let sent = channel.sent_messages();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].contains("진행 중인 작업이 없습니다"));
}
