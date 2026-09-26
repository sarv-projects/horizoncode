//! Approval resolution for the headless CLI.
//!
//! The default headless posture denies every `ask` (it never blocks on stdin);
//! `--yolo` uses the guard's auto-approve resolver; an interactive terminal gets
//! a prompt. No resolver can widen the catastrophic gate, which Guard applies
//! before asking.

use std::io::{BufRead, Write};

use agentx_guard::{ApprovalReply, ApprovalRequest, ApprovalResolver};
use async_trait::async_trait;

/// Prompts the terminal for an approval decision.
#[derive(Debug, Default, Clone, Copy)]
pub struct InteractiveApprovalResolver;

#[async_trait]
impl ApprovalResolver for InteractiveApprovalResolver {
    async fn resolve(&self, request: &ApprovalRequest) -> ApprovalReply {
        if request.catastrophic {
            return ApprovalReply::Reject;
        }
        let prompt = request.prompt.clone();
        let reply = tokio::task::spawn_blocking(move || prompt_user(&prompt))
            .await
            .unwrap_or_default();
        match reply.trim().to_ascii_lowercase().as_str() {
            "o" | "once" | "y" | "yes" => ApprovalReply::Once,
            "a" | "always" => ApprovalReply::Always,
            _ => ApprovalReply::Reject,
        }
    }
}

fn prompt_user(prompt: &str) -> String {
    let stderr = std::io::stderr();
    let mut lock = stderr.lock();
    let _ = writeln!(lock, "[approval] {prompt}");
    let _ = write!(lock, "  allow [o]nce / [a]lways / [r]eject: ");
    let _ = lock.flush();
    drop(lock);
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return String::new();
    }
    line
}
