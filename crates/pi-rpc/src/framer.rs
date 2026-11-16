//! JSONL framing for pi's RPC stream.
//!
//! pi writes exactly one JSON object per line, terminated by LF. The framing
//! rules are stricter than a generic line reader:
//!
//! * split records only on `\n` (never on `U+2028` / `U+2029`, which are valid
//!   inside JSON strings);
//! * strip one optional trailing `\r`;
//! * skip blank lines;
//! * never let a malformed record grow without bound.
//!
//! `BufRead::lines()` in most ecosystems gets the first two right, but this
//! module keeps the rules explicit and testable.

/// Default maximum size of a single record (64 MiB). Larger records are
/// dropped and the framer resynchronizes on the next newline.
pub const DEFAULT_MAX_LINE: usize = 64 * 1024 * 1024;

/// Incremental splitter for the pi RPC JSONL stream.
#[derive(Debug)]
pub struct Framer {
    buf: Vec<u8>,
    max_line: usize,
    oversized: u64,
    dropping: bool,
}

impl Default for Framer {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_LINE)
    }
}

impl Framer {
    pub fn new(max_line: usize) -> Self {
        Self {
            buf: Vec::new(),
            max_line,
            oversized: 0,
            dropping: false,
        }
    }

    /// Feed raw bytes from the child's stdout. Returns the complete records
    /// (without the trailing newline) that are now available, in order.
    pub fn push(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        for part in data.split_inclusive(|&byte| byte == b'\n') {
            let complete = part.last() == Some(&b'\n');
            let bytes = if complete {
                &part[..part.len() - 1]
            } else {
                part
            };
            if self.dropping {
                if complete {
                    self.dropping = false;
                }
                continue;
            }
            if bytes.len() > self.max_line.saturating_sub(self.buf.len()) {
                self.buf.clear();
                self.oversized += 1;
                self.dropping = !complete;
                continue;
            }
            self.buf.extend_from_slice(bytes);
            if complete {
                if self.buf.last() == Some(&b'\r') {
                    self.buf.pop();
                }
                if self.buf.iter().any(|byte| !byte.is_ascii_whitespace()) {
                    out.push(std::mem::take(&mut self.buf));
                } else {
                    self.buf.clear();
                }
            }
        }

        out
    }

    /// Number of records dropped because they exceeded `max_line`.
    pub fn oversized(&self) -> u64 {
        self.oversized
    }

    /// Bytes buffered for the next incomplete record.
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(framer: &mut Framer, chunks: &[&[u8]]) -> Vec<String> {
        let mut out = Vec::new();
        for chunk in chunks {
            for line in framer.push(chunk) {
                out.push(String::from_utf8(line).unwrap());
            }
        }
        out
    }

    #[test]
    fn splits_records_across_arbitrary_chunks() {
        let mut framer = Framer::default();
        assert!(lines(&mut framer, &[br#"{"a":1"#]).is_empty());
        assert!(lines(&mut framer, &[br#"}"#]).is_empty());
        assert_eq!(
            lines(&mut framer, &[b"\n{\"b\":2}\n"]),
            vec![r#"{"a":1}"#, r#"{"b":2}"#]
        );
    }

    #[test]
    fn strips_crlf_and_blank_lines() {
        let mut framer = Framer::default();
        let got = lines(&mut framer, &[b"{\"a\":1}\r\n\r\n\n{\"b\":2}\r\n"]);
        assert_eq!(got, vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn does_not_split_on_unicode_line_separators() {
        // U+2028 (E2 80 A8) is legal inside a JSON string.
        let mut framer = Framer::default();
        let got = lines(&mut framer, &[b"{\"t\":\"a\xe2\x80\xa8b\"}\n"]);
        assert_eq!(got, vec!["{\"t\":\"a\u{2028}b\"}"]);
    }

    #[test]
    fn oversized_record_is_dropped_and_stream_resyncs() {
        let mut framer = Framer::new(16);
        assert!(lines(&mut framer, &[b"0123456789abcdefghij"]).is_empty());
        assert_eq!(framer.oversized(), 1);
        // The rest of the oversized record is discarded, then a fresh record parses.
        let got = lines(&mut framer, &[b"ijklmn\n{\"ok\":true}\n"]);
        assert_eq!(got, vec![r#"{"ok":true}"#]);
    }

    #[test]
    fn complete_oversized_record_is_rejected_before_copying() {
        let mut framer = Framer::new(16);
        assert!(framer.push(b"012345678901234567890123456789\n").is_empty());
        assert_eq!(framer.oversized(), 1);
        assert_eq!(framer.buffered(), 0);
        assert_eq!(framer.push(b"ok\n"), vec![b"ok".to_vec()]);
    }

    #[test]
    fn endless_oversized_record_never_accumulates_dropped_bytes() {
        let mut framer = Framer::new(16);
        for _ in 0..100 {
            assert!(framer.push(&[b'x'; 100]).is_empty());
            assert_eq!(framer.buffered(), 0);
        }
        assert_eq!(framer.oversized(), 1);
        assert_eq!(framer.push(b"tail\nok\n"), vec![b"ok".to_vec()]);
    }

    #[test]
    fn chunks_split_inside_utf8_preserve_exact_bytes() {
        let text = "中文\u{2028}x\r\n";
        let mut framer = Framer::new(64);
        let mut records = Vec::new();
        for byte in text.as_bytes() {
            records.extend(framer.push(std::slice::from_ref(byte)));
        }
        assert_eq!(records, vec!["中文\u{2028}x".as_bytes().to_vec()]);
    }
}
