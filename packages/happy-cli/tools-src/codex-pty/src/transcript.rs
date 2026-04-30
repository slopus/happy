use std::collections::HashSet;

pub struct TranscriptPrinter {
    printed_keys: HashSet<String>,
    saw_prompt: bool,
}

impl TranscriptPrinter {
    pub fn new() -> Self {
        Self {
            printed_keys: HashSet::new(),
            saw_prompt: false,
        }
    }

    pub fn on_screen(&mut self, screen: &str) -> Vec<String> {
        if extract_chat_area(screen).prompt_row.is_some() {
            self.saw_prompt = true;
        }

        // Avoid emitting transcript until the TUI has reached an interactive state at least once.
        if !self.saw_prompt {
            return Vec::new();
        }

        // Skip spinner/busy frames; they cause partial transcript snapshots.
        if screen.contains("esc to interrupt") {
            return Vec::new();
        }


        let candidates = extract_transcript_candidates(screen);

        let mut emitted: Vec<String> = Vec::new();
        for line in candidates {
            let key = transcript_key(&line);
            if self.printed_keys.insert(key) {
                emitted.push(line);
            }
        }

        emitted
    }
}

fn transcript_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;

    for ch in s.chars() {
        let ws = ch.is_whitespace();
        if ws {
            if !prev_ws {
                out.push(' ');
            }
        } else {
            out.push(ch);
        }
        prev_ws = ws;
    }

    out.trim().to_string()
}

fn is_ui_noise_line(raw: &str) -> bool {
    let trimmed = raw.trim();

    let is_context_left = trimmed
        .strip_suffix("% context left")
        .is_some_and(|prefix| {
            let prefix = prefix.trim();
            !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit())
        });

    is_context_left
        || raw.starts_with("? for shortcuts")
        || raw.starts_with("model:")
        || raw.starts_with("directory:")
        || raw.starts_with("╭")
        || raw.starts_with("╰")
        || raw.starts_with("│")
        || raw.starts_with("◦")
        || raw.starts_with("◯")
        || raw.starts_with("○")
        || trimmed.contains("esc to interrupt")
}

fn strip_hanging_indent(raw: &str) -> &str {
    raw.strip_prefix("  ").unwrap_or(raw)
}

fn is_prompt_marker_line(raw: &str) -> bool {
    raw.starts_with("> ") || raw == ">" || raw.starts_with("› ") || raw == "›"
}

fn strip_prompt_marker(raw: &str) -> Option<&str> {
    if let Some(rest) = raw.strip_prefix("> ") {
        Some(rest)
    } else if raw == ">" {
        Some("")
    } else if let Some(rest) = raw.strip_prefix("› ") {
        Some(rest)
    } else if raw == "›" {
        Some("")
    } else {
        None
    }
}

fn is_system_notice_line(trimmed_start: &str) -> bool {
    if trimmed_start.starts_with("Tip:")
        || trimmed_start.starts_with("> ")
        || trimmed_start == ">"
        || trimmed_start.starts_with("› ")
        || trimmed_start == "›"
        || trimmed_start.starts_with("• ")
    {
        return false;
    }

    let trimmed = trimmed_start.trim();

    if trimmed.starts_with("⚠") {
        return true;
    }

    if let Some(idx) = trimmed.find("Heads up,") {
        if idx <= 4
            && (trimmed.contains("weekly limit")
                || trimmed.contains("/status")
                || trimmed.contains("%"))
        {
            return true;
        }
    }

    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatArea {
    pub lines: Vec<String>,
    pub prompt_row: Option<usize>,
}

impl ChatArea {
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

pub fn extract_chat_area(screen: &str) -> ChatArea {
    let lines: Vec<&str> = screen.lines().collect();

    let mut prompt_row: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if is_prompt_marker_line(line) {
            prompt_row = Some(i);
        }
    }

    let end = prompt_row.unwrap_or(lines.len());

    let mut out: Vec<String> = Vec::new();
    for i in 0..end {
        let ln = lines[i].trim_end();

        if is_ui_noise_line(ln) {
            continue;
        }

        out.push(ln.to_string());
    }

    while out.last().is_some_and(|s| s.trim().is_empty()) {
        out.pop();
    }

    ChatArea {
        lines: out,
        prompt_row,
    }
}

pub fn mirror_assistant_screen(screen: &str, rows: usize) -> Vec<String> {
    let mut out: Vec<String> = screen.lines().map(|l| l.trim_end().to_string()).collect();

    if out.len() < rows {
        out.resize(rows, String::new());
    }
    out.truncate(rows);

    let mut prompt_row: Option<usize> = None;
    for (i, line) in out.iter().enumerate() {
        if is_prompt_marker_line(line) {
            prompt_row = Some(i);
        }
    }

    for (i, line) in out.iter_mut().enumerate() {
        if is_ui_noise_line(line) {
            line.clear();
            continue;
        }

        if let Some(pr) = prompt_row {
            if i >= pr {
                line.clear();
            }
        }
    }

    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatDeltaKind {
    Initial,
    Append,
    Rewrite,
    NoChange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatDeltaUpdate {
    pub kind: ChatDeltaKind,
    pub delta: String,
}

pub struct ChatDeltaEmitter {
    prev: String,
    pub rewrite_events: u64,
    pub total_emitted_chars: u64,
    pub last_delta_chars: u64,
}

impl ChatDeltaEmitter {
    pub fn new() -> Self {
        Self {
            prev: String::new(),
            rewrite_events: 0,
            total_emitted_chars: 0,
            last_delta_chars: 0,
        }
    }

    pub fn on_chat_text(&mut self, chat_text: &str) -> ChatDeltaUpdate {
        if chat_text == self.prev {
            self.last_delta_chars = 0;
            return ChatDeltaUpdate {
                kind: ChatDeltaKind::NoChange,
                delta: String::new(),
            };
        }

        if self.prev.is_empty() {
            self.prev = chat_text.to_string();
            let delta_chars = chat_text.chars().count() as u64;
            self.total_emitted_chars += delta_chars;
            self.last_delta_chars = delta_chars;
            return ChatDeltaUpdate {
                kind: ChatDeltaKind::Initial,
                delta: chat_text.to_string(),
            };
        }

        let lcp = common_prefix_byte_index(&self.prev, chat_text);
        if lcp == self.prev.len() {
            let delta = chat_text[lcp..].to_string();
            self.prev = chat_text.to_string();

            let delta_chars = delta.chars().count() as u64;
            self.total_emitted_chars += delta_chars;
            self.last_delta_chars = delta_chars;

            return ChatDeltaUpdate {
                kind: ChatDeltaKind::Append,
                delta,
            };
        }

        self.prev = chat_text.to_string();
        self.rewrite_events += 1;
        self.last_delta_chars = 0;

        ChatDeltaUpdate {
            kind: ChatDeltaKind::Rewrite,
            delta: String::new(),
        }
    }
}

fn common_prefix_byte_index(a: &str, b: &str) -> usize {
    let mut a_it = a.chars();
    let mut last = 0usize;

    for (idx_b, ch_b) in b.char_indices() {
        let Some(ch_a) = a_it.next() else {
            return last;
        };

        if ch_a != ch_b {
            return last;
        }

        last = idx_b + ch_b.len_utf8();
    }

    last
}

pub fn extract_transcript_candidates(screen: &str) -> Vec<String> {
    let mut out = Vec::new();

    let lines: Vec<&str> = screen.lines().collect();

    // The current input prompt is the last row that starts with the prompt markers.
    // Exclude it from transcript extraction so we don't treat in-progress input as a user turn.
    let mut prompt_row: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if is_prompt_marker_line(line) {
            prompt_row = Some(i);
        }
    }

    let mut i = 0usize;

    while i < lines.len() {
        let raw = lines[i].trim_end();
        let trimmed_start = raw.trim_start();
        let trimmed = trimmed_start.trim();

        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        if is_ui_noise_line(raw) {
            i += 1;
            continue;
        }

        if is_system_notice_line(trimmed_start) {
            // System notice lines (quota warnings, etc.).
            let mut msg_lines: Vec<String> = Vec::new();
            msg_lines.push(format!("system: {trimmed}"));
            i += 1;

            let mut pending_blank = false;
            while i < lines.len() {
                let raw2 = lines[i].trim_end();
                let t2 = raw2.trim();

                if t2.is_empty() {
                    pending_blank = true;
                    i += 1;
                    continue;
                }

                // Start of a new block.
                let t2s = raw2.trim_start();
                if t2s.starts_with("Tip:")
                    || is_system_notice_line(t2s)
                    || raw2.starts_with("• ")
                    || raw2.starts_with("> ")
                    || raw2 == ">"
                    || raw2.starts_with("› ")
                    || raw2 == "›"
                {
                    break;
                }

                if is_ui_noise_line(raw2) {
                    break;
                }

                if pending_blank {
                    msg_lines.push(String::new());
                    pending_blank = false;
                }

                msg_lines.push(strip_hanging_indent(raw2).to_string());
                i += 1;
            }

            while msg_lines.last().is_some_and(|s| s.trim().is_empty()) {
                msg_lines.pop();
            }

            out.push(msg_lines.join("\n"));
            continue;
        }

        if trimmed.starts_with("Tip:") {
            let mut msg_lines: Vec<String> = Vec::new();
            msg_lines.push(format!("system: {trimmed}"));
            i += 1;

            let mut pending_blank = false;
            while i < lines.len() {
                let raw2 = lines[i].trim_end();
                let t2 = raw2.trim();

                if t2.is_empty() {
                    pending_blank = true;
                    i += 1;
                    continue;
                }

                // Start of a new block.
                let t2s = raw2.trim_start();
                if t2s.starts_with("Tip:")
                    || is_system_notice_line(t2s)
                    || raw2.starts_with("• ")
                    || raw2.starts_with("> ")
                    || raw2 == ">"
                    || raw2.starts_with("› ")
                    || raw2 == "›"
                {
                    break;
                }

                if is_ui_noise_line(raw2) {
                    break;
                }

                if pending_blank {
                    msg_lines.push(String::new());
                    pending_blank = false;
                }

                // Preserve indentation as shown on screen.
                msg_lines.push(raw2.to_string());
                i += 1;
            }

            while msg_lines.last().is_some_and(|s| s.trim().is_empty()) {
                msg_lines.pop();
            }

            out.push(msg_lines.join("\n"));
            continue;
        }

        if is_prompt_marker_line(raw) && prompt_row.is_some_and(|pr| pr == i) {
            // Skip the current input prompt row.
            i += 1;
            continue;
        }

        if is_prompt_marker_line(raw) {
            let content = strip_prompt_marker(raw).unwrap_or(raw).trim_end();
            // (content extracted above)
            // (content extracted above)
            if content.trim().is_empty() {
                i += 1;
                continue;
            }

            let mut msg_lines: Vec<String> = Vec::new();
            msg_lines.push(format!("user: {content}"));
            i += 1;

            let mut pending_blank = false;
            while i < lines.len() {
                let raw2 = lines[i].trim_end();
                let t2 = raw2.trim();

                if t2.is_empty() {
                    pending_blank = true;
                    i += 1;
                    continue;
                }

                // Start of a new block.
                let t2s = raw2.trim_start();
                if is_system_notice_line(t2s)
                    || raw2.starts_with("• ")
                    || raw2.starts_with("> ")
                    || raw2 == ">"
                    || raw2.starts_with("› ")
                    || raw2 == "›"
                {
                    break;
                }

                if is_ui_noise_line(raw2) {
                    break;
                }

                if pending_blank {
                    msg_lines.push(String::new());
                    pending_blank = false;
                }

                // Remove Codex 2-space hanging indent under the prompt marker.
                msg_lines.push(strip_hanging_indent(raw2).to_string());
                i += 1;
            }

            while msg_lines.last().is_some_and(|s| s.trim().is_empty()) {
                msg_lines.pop();
            }

            out.push(msg_lines.join("\n"));
            continue;
        }

        if raw.starts_with("• ") {
            if trimmed.contains("Working") || trimmed.contains("esc to interrupt") {
                i += 1;
                continue;
            }

            let mut msg_lines: Vec<String> = Vec::new();
            let content = raw.strip_prefix("• ").unwrap_or(raw);
            msg_lines.push(format!("assistant: {content}"));
            i += 1;

            let mut pending_blank = false;
            while i < lines.len() {
                let raw2 = lines[i].trim_end();
                let t2 = raw2.trim();

                if t2.is_empty() {
                    pending_blank = true;
                    i += 1;
                    continue;
                }

                // Start of a new block.
                let t2s = raw2.trim_start();
                if is_system_notice_line(t2s)
                    || raw2.starts_with("• ")
                    || raw2.starts_with("> ")
                    || raw2 == ">"
                    || raw2.starts_with("› ")
                    || raw2 == "›"
                {
                    break;
                }

                if is_ui_noise_line(raw2) {
                    break;
                }

                if pending_blank {
                    msg_lines.push(String::new());
                    pending_blank = false;
                }

                // Remove Codex 2-space hanging indent under the bullet marker.
                msg_lines.push(strip_hanging_indent(raw2).to_string());
                i += 1;
            }

            while msg_lines.last().is_some_and(|s| s.trim().is_empty()) {
                msg_lines.pop();
            }

            out.push(msg_lines.join("\n"));
            continue;
        }

        i += 1;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::{
        ChatDeltaEmitter, ChatDeltaKind, TranscriptPrinter, extract_chat_area,
        extract_transcript_candidates, mirror_assistant_screen,
    };

    #[test]
    fn extracts_bullet_with_continuations_and_lists() {
        let screen = "Tip: A tip\n\n• First line\n  continuation one\n\n  continuation two\n- list a\n1. list b\n> prompt\n";

        let out = extract_transcript_candidates(screen);
        assert_eq!(out.len(), 2);

        assert_eq!(out[0], "system: Tip: A tip");
        assert_eq!(
            out[1],
            "assistant: First line\ncontinuation one\n\ncontinuation two\n- list a\n1. list b"
        );
    }

    #[test]
    fn extracts_tip_with_continuations() {
        let screen = "  Tip: Hello
  second line

• assistant
> prompt
";

        let out = extract_transcript_candidates(screen);
        assert_eq!(out.len(), 2);

        assert_eq!(
            out[0],
            "system: Tip: Hello
  second line"
        );
        assert_eq!(out[1], "assistant: assistant");
    }

    #[test]
    fn extracts_user_turns_but_skips_current_prompt() {
        let screen = "> previous line one\n  previous line two\n\n• assistant line\n  assistant cont\n\n› draft input\n  draft cont\n? for shortcuts\n";

        let out = extract_transcript_candidates(screen);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], "user: previous line one\nprevious line two");
        assert_eq!(out[1], "assistant: assistant line\nassistant cont");
    }

    #[test]
    fn prompt_marker_without_trailing_space_is_skipped() {
        let screen = "• hello\n>\n";

        let out = extract_transcript_candidates(screen);
        assert_eq!(out, vec!["assistant: hello".to_string()]);
    }

    #[test]
    fn extracts_unicode_prompt_marker_user_turn() {
        let screen = "› hello
  world

> prompt
";

        let out = extract_transcript_candidates(screen);
        assert_eq!(out, vec!["user: hello\nworld".to_string()]);
    }

    #[test]
    fn assistant_continuation_can_start_with_quote_or_tip() {
        let screen = "• First line
  > quoted continuation
  Tip: Keep it simple.
> prompt
";

        let out = extract_transcript_candidates(screen);
        assert_eq!(
            out,
            vec!["assistant: First line\n> quoted continuation\nTip: Keep it simple.".to_string()]
        );
    }

    #[test]
    fn assistant_can_emit_box_drawing_lines() {
        let screen = "• ╭foo╮\n  │bar│\n  ╰baz╯\n> prompt\n";

        let out = extract_transcript_candidates(screen);
        assert_eq!(out, vec!["assistant: ╭foo╮\n│bar│\n╰baz╯".to_string()]);
    }

    #[test]
    fn assistant_tool_block_can_include_trailing_summary_after_separator() {
        let screen = "• Ran date\n  └ Monday, February 16, 2026\n\n  --------\n\n  Monday, February 16, 2026\n> prompt\n";

        let out = extract_transcript_candidates(screen);
        assert_eq!(
            out,
            vec![
                "assistant: Ran date\n└ Monday, February 16, 2026\n\n--------\n\nMonday, February 16, 2026"
                    .to_string()
            ]
        );
    }

    #[test]
    fn extracts_heads_up_warning_with_continuation() {
        let screen = "⚠ Heads up, you have less than 25% of your weekly limit left.\n  Run /status for a breakdown.\n> prompt\n";

        let out = extract_transcript_candidates(screen);
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0],
            "system: ⚠ Heads up, you have less than 25% of your weekly limit left.\nRun /status for a breakdown."
        );
    }

    #[test]
    fn transcript_printer_emits_only_when_prompt_visible() {
        let streaming = "\
• The smell of pizza drifted down the hallway.\n\
  Warm and peppery.\n\
";

        let streaming_ws = "\
• The smell   of  pizza drifted down the hallway.\n\
  Warm   and peppery.\n\
";

        let settled = "\
• The smell of pizza drifted down the hallway.\n\
  Warm and peppery.\n\
> prompt\n\
";

        let mut p = TranscriptPrinter::new();

        assert!(p.on_screen(streaming).is_empty());
        assert!(p.on_screen(streaming_ws).is_empty());

        let out = p.on_screen(settled);
        assert_eq!(out.len(), 1);

        // Further identical frames should not re-emit.
        assert!(p.on_screen(settled).is_empty());
    }

    #[test]
    fn transcript_printer_suppresses_busy_frames() {
        let busy = "\
• First line\n\
  continuation\n\
◦ Working (1s • esc to interrupt)\n\
> prompt\n\
";

        let settled = "\
• First line\n\
  continuation\n\
> prompt\n\
";

        let mut p = TranscriptPrinter::new();

        assert!(p.on_screen(busy).is_empty());

        let out = p.on_screen(settled);
        assert_eq!(out, vec!["assistant: First line\ncontinuation".to_string()]);

        assert!(p.on_screen(settled).is_empty());
    }

    #[test]
    fn drops_busy_spinner_artifacts_after_assistant_reply() {
        let screen = "\
• /Users/tartavull\n\
◦\n\
Cnfrming current directoy (4s • esc to interrupt)\n\
4\n\
g\n\
ng\n\
in\n\
ki\n\
rk\n\
or\n\
Wog\n\
Wng\n\
> prompt\n\
";

        let out = extract_transcript_candidates(screen);
        assert_eq!(out, vec!["assistant: /Users/tartavull".to_string()]);
    }

    #[test]
    fn chat_area_excludes_prompt_and_noise() {
        let screen = "\
model: foo\n\
Hello\n\
\n\
> input\n\
";

        let chat = extract_chat_area(screen);
        assert_eq!(chat.lines, vec!["Hello".to_string()]);
        assert_eq!(chat.prompt_row, Some(3));
    }

    #[test]
    fn mirror_blanks_noise_and_prompt_and_below() {
        let screen = "\
model: foo\n\
Hello\n\
> input\n\
TAIL\n\
";

        let mirrored = mirror_assistant_screen(screen, 4);
        assert_eq!(mirrored.len(), 4);
        assert_eq!(mirrored[0], "");
        assert_eq!(mirrored[1], "Hello");
        assert_eq!(mirrored[2], "");
        assert_eq!(mirrored[3], "");
    }

    #[test]
    fn delta_emitter_initial_then_append_then_rewrite() {
        let mut d = ChatDeltaEmitter::new();

        let a = d.on_chat_text("Hello");
        assert_eq!(a.kind, ChatDeltaKind::Initial);
        assert_eq!(a.delta, "Hello");

        let b = d.on_chat_text("Hello world");
        assert_eq!(b.kind, ChatDeltaKind::Append);
        assert_eq!(b.delta, " world");

        let c = d.on_chat_text("Different");
        assert_eq!(c.kind, ChatDeltaKind::Rewrite);
        assert_eq!(c.delta, "");
        assert_eq!(d.rewrite_events, 1);
    }
}
