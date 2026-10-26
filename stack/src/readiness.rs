//! A running process is not yet a playable stack. Char registers with login
//! independently of map loading; both acknowledgements must belong to the
//! current processes before startup or a managed restart reports success.
use crate::docker::Docker;
use std::time::{Duration, Instant};

const SERVERS: [&str; 3] = ["ragnarok-login", "ragnarok-char", "ragnarok-map"];

/// What `wait` returns when the budget runs out with every server still
/// running. Callers compare against it to tell "slow" from "stopped".
pub(crate) const TIMED_OUT: &str =
    "Timed out waiting for character registration with login-server and map loading";

// The pinned engine normalizes StartedAt and log records to RFC3339Nano UTC.
// Unknown formats fail closed rather than comparing arbitrary strings.
fn timestamp(value: &str) -> Option<&str> {
    let stamp = value.get(..30)?;
    for (index, byte) in stamp.bytes().enumerate() {
        let expected = match index {
            4 | 7 => Some(b'-'),
            10 => Some(b'T'),
            13 | 16 => Some(b':'),
            19 => Some(b'.'),
            29 => Some(b'Z'),
            _ => None,
        };
        if expected
            .map(|e| byte != e)
            .unwrap_or(!byte.is_ascii_digit())
        {
            return None;
        }
    }
    Some(stamp)
}

fn current_ready_logs(logs: &[String; 2], started: &[String; 3]) -> bool {
    let [Some(login), Some(char_start), Some(map)] = started.each_ref().map(|s| timestamp(s))
    else {
        return false;
    };
    let mut login_ready = None;
    let mut maps_ready = None;
    let mut login_lost = None;
    let mut map_lost = None;
    // stdout and stderr are separate streams. Compare event timestamps, never
    // their concatenation order. A known disconnect at the same timestamp as
    // an acknowledgement is conservatively pending until fresh evidence.
    for log in logs {
        let mut record_time = None;
        for line in log.lines() {
            // A single timestamped engine record can contain several lines.
            if let Some(time) = timestamp(line) {
                record_time = Some(time);
            }
            let Some(time) = record_time.filter(|time| *time >= char_start) else {
                continue;
            };
            if line.contains("Connected to login-server (connection #") && time >= login {
                login_ready = login_ready.max(Some(time));
            }
            if line.contains("Map-server ") && line.contains(" loading complete.") && time >= map {
                maps_ready = maps_ready.max(Some(time));
            }
            if line.contains("Connection to Login Server lost.") {
                login_lost = login_lost.max(Some(time));
            }
            if line.contains("Map-server #") && line.contains(" has disconnected.") {
                map_lost = map_lost.max(Some(time));
            }
        }
    }
    login_ready.is_some()
        && maps_ready.is_some()
        && login_ready > login_lost
        && maps_ready > map_lost
}

fn processes(dk: &Docker) -> Option<[String; 3]> {
    Some([
        dk.started_at(SERVERS[0])?,
        dk.started_at(SERVERS[1])?,
        dk.started_at(SERVERS[2])?,
    ])
}

/// Keep the caller's startup budget. A managed restart also requires a new
/// char generation; deliberately partial stacks retain their existing policy.
pub(crate) fn wait(
    dk: &Docker,
    previous_char: Option<&str>,
    budget: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        let dead: Vec<&str> = SERVERS
            .iter()
            .copied()
            .filter(|name| matches!(dk.state(name).as_deref(), Some("exited" | "dead")))
            .collect();
        if !dead.is_empty() {
            let tail = dk.logs(dead[0], "8");
            let reason = tail
                .lines()
                .filter(|l| l.contains("Error") || l.contains("error"))
                .last()
                .map(strip_ansi)
                .unwrap_or_else(|| "no error was logged".into());
            return Err(format!(
                "{} stopped during startup: {reason}",
                dead.join(", ")
            ));
        }
        if let Some(started) = processes(dk) {
            if Some(started[1].as_str()) != previous_char
                && current_ready_logs(&dk.timestamped_logs(SERVERS[1]), &started)
                // Inspection and log reads are separate commands. A process
                // changing during observation invalidates this snapshot.
                && processes(dk).as_ref() == Some(&started)
            {
                return Ok(());
            }
        }
        // Each pass is up to ten engine CLI calls; on Windows every one is a
        // process spawn competing with the VM that is loading the maps.
        std::thread::sleep(
            Duration::from_secs(1).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
    Err(TIMED_OUT.into())
}

/// Keep rAthena's useful error text without its terminal colour sequences.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_current_registration_and_maps() {
        let started = ["2026-09-07T11:18:09.738166241Z"; 3].map(str::to_owned);
        let old = "2026-09-07T11:13:18.804860894Z status\nMap-server 0 loading complete.\nConnected to login-server (connection #7).\n";
        assert!(!current_ready_logs(&[old.into(), String::new()], &started));
        assert!(!current_ready_logs(
            &[
                "Map-server 0 loading complete.\nConnected to login-server (connection #7).\n"
                    .into(),
                String::new()
            ],
            &started
        ));
        let maps =
            format!("{old}2026-09-07T11:18:15.142207452Z status\nMap-server 0 loading complete.\n");
        assert!(
            !current_ready_logs(&[maps.clone(), String::new()], &started),
            "maps can register before char authenticates with login"
        );
        let ack =
            "2026-09-07T11:18:19.142207452Z status\nConnected to login-server (connection #7).\n";
        let mut logs = [maps, ack.into()];
        assert!(
            current_ready_logs(&logs, &started),
            "evidence can arrive on either stream"
        );
        assert!(!current_ready_logs(
            &logs,
            &["unknown".into(), started[1].clone(), started[2].clone()]
        ));
        let mut later_peer = started.clone();
        later_peer[0] = "2026-09-07T11:18:20.000000000Z".into();
        assert!(
            !current_ready_logs(&logs, &later_peer),
            "a restarted peer needs a fresh acknowledgement"
        );
        logs[0].push_str("2026-09-07T11:18:21.000000000Z Connection to Login Server lost.\n");
        assert!(
            !current_ready_logs(&logs, &started),
            "later disconnect overrides an ACK on the other stream"
        );
        logs[1].push_str(
            "2026-09-07T11:18:22.000000000Z Connected to login-server (connection #8).\n",
        );
        assert!(current_ready_logs(&logs, &started));
        logs[1].push_str("2026-09-07T11:18:23.000000000Z Map-server #6 has disconnected.\n");
        assert!(!current_ready_logs(&logs, &started));
    }

    #[test]
    fn readiness_timeout_is_a_failure() {
        let dk = Docker::new("unused".into(), "unused".into(), "unused".into());
        assert!(wait(&dk, None, Duration::ZERO)
            .unwrap_err()
            == TIMED_OUT);
    }
}
