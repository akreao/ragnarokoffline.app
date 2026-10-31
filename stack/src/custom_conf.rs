//! The character-server lines from Settings -> Rates -> Advanced.
//!
//! The box is written to battle_conf.txt by the shell (electron/custom-conf.js),
//! and only the map server reads that file. A few keys in it belong to the
//! character server instead -- the ones that decide which names a new character
//! may have -- and typed into the box they used to do nothing at all: the map
//! server logged "Unknown setting" and the character server never saw them.
//! A player who set `char_name_option: 0` to allow Japanese names still got
//! "Creation is denied".
//!
//! So the supervisor reads those keys from settings.json and writes them into
//! char_conf.txt, which it regenerates on every start. Only the keys in
//! CHAR_KEYS, each with its own check: char_conf.txt also holds char_ip and
//! login_ip, and the box must not be a way to set those. The shell keeps the
//! same list and the same checks, and reports what it left out; here a line
//! that fails a check is simply not written.
use crate::json::Value;

/// Must match CHAR_KEYS in electron/custom-conf.js (tests/custom-conf.test.cjs
/// compares them). Not char_name_min_length: the client refuses a name under
/// four UTF-8 bytes before sending it, so a lower minimum could not be reached.
pub const CHAR_KEYS: &[&str] = &["char_name_option", "char_name_letters"];

/// Same limit as the shell's MAX_BYTES: an oversized box writes nothing.
const MAX_BYTES: usize = 8 * 1024;

fn accepts(key: &str, value: &str) -> bool {
    match key {
        // 0: any name, 1: only char_name_letters, 2: anything but those.
        "char_name_option" => matches!(value, "0" | "1" | "2"),
        // rAthena reads the rest of the line, so a list may contain spaces.
        "char_name_letters" => value.len() <= 1023,
        _ => false,
    }
}

/// The char_conf.txt lines the player's Advanced box asks for, or "".
pub fn char_lines(settings: &Value) -> String {
    let text = match settings.str("custom_battle_conf") {
        Some(text) if text.len() <= MAX_BYTES => text,
        _ => return String::new(),
    };
    let mut out = String::new();
    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        let Some(colon) = line.find(':') else { continue };
        let key = line[..colon].trim().to_ascii_lowercase();
        let value = line[colon + 1..].trim();
        if !CHAR_KEYS.contains(&key.as_str()) {
            continue;
        }
        // Printable ASCII only, as in the shell: nothing that could carry a
        // newline, and so a second setting, into the file.
        if value.is_empty() || !value.bytes().all(|b| (b' '..=b'~').contains(&b)) {
            continue;
        }
        if accepts(&key, value) {
            out.push_str(&format!("{key}: {value}\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json;

    fn lines(box_text: &str) -> String {
        let settings = json::parse(&format!("{{\"custom_battle_conf\":{}}}", json::quote(box_text))).unwrap();
        char_lines(&settings)
    }

    #[test]
    fn name_keys_reach_the_character_server() {
        assert_eq!(lines("drop_rate_cap: 10000\nchar_name_option: 0\n"), "char_name_option: 0\n");
        assert_eq!(lines("  CHAR_NAME_OPTION: 2  \r\nchar_name_letters: @ #$\r\n"),
                   "char_name_option: 2\nchar_name_letters: @ #$\n");
    }

    #[test]
    fn nothing_else_reaches_it() {
        for text in ["char_ip: 1.2.3.4", "login_ip: evil", "start_point: prontera,1,1", "import: x",
                     "// char_name_option: 0", "char_name_option: 3", "char_name_option: 0 1",
                     "char_name_min_length: 2",
                     "char_name_option:", "char_name_letters: \u{3042}"] {
            assert_eq!(lines(text), "", "{text}");
        }
    }

    #[test]
    fn missing_or_oversized_box_writes_nothing() {
        assert_eq!(char_lines(&json::parse("{}").unwrap()), "");
        assert_eq!(char_lines(&json::parse("{\"custom_battle_conf\":5}").unwrap()), "");
        assert_eq!(lines(&"char_name_option: 0\n".repeat(MAX_BYTES / 20 + 1)), "");
    }
}
