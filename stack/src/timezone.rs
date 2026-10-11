//! The game servers' clock: which time zone rAthena's `localtime()` reads.
//!
//! WoE times, `OnClock` and `OnHour` events, `gettime()` and daily resets all
//! follow it. The containers are Alpine with tzdata and no zone of their own,
//! so without `TZ` they run on UTC, whatever the player's clock says.
//!
//! settings.json's `server_timezone` chooses: `null` (or absent) follows the
//! computer the app runs on, which the shell hands over as
//! `RAGNAROK_HOST_TIMEZONE` (Electron's `Intl` names the zone the same way on
//! every platform); a string is an IANA zone, `UTC` included. Run without the
//! shell, "follow this computer" has nothing to follow and stays on UTC.
//!
//! Only the game servers get it. MariaDB keeps UTC: it is not restarted when
//! the setting changes, so giving it a zone would leave the two disagreeing
//! until it next was, and rAthena keeps its own times as epoch seconds.
use crate::config::Config;
use crate::json::Value;

const ERROR: &str = "Cannot read the server clock setting. Choose a time zone in Settings.";

/// The host's zone, as the shell reads it.
pub const HOST_VAR: &str = "RAGNAROK_HOST_TIMEZONE";

/// A name that can be an IANA zone (`UTC`, `Europe/Berlin`,
/// `America/Argentina/Buenos_Aires`, `Etc/GMT+5`): letters, digits, `_`, `+`
/// and `-` in up to three parts. Checked rather than trusted because it ends up
/// on a `docker run` command line. Whether tzdata has it is musl's to say; a
/// name it lacks reads as UTC.
pub fn valid(zone: &str) -> bool {
    let parts: Vec<&str> = zone.split('/').collect();
    !zone.is_empty()
        && zone.len() <= 64
        && parts.len() <= 3
        && parts.iter().all(|p| {
            p.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-'))
        })
}

/// The zone the game servers run in, from settings.json and the host.
pub fn chosen(cfg: &Config) -> Result<String, String> {
    let settings = crate::registration::settings(&cfg.state).map_err(|_| ERROR)?;
    match settings.get("server_timezone") {
        None | Some(Value::Null) => Ok(host()),
        Some(Value::String(zone)) if valid(zone) => Ok(zone.clone()),
        Some(_) => Err(ERROR.into()),
    }
}

/// The computer's zone, or UTC when the shell did not say (or said nonsense).
fn host() -> String {
    std::env::var(HOST_VAR).ok().filter(|z| valid(z)).unwrap_or_else(|| "UTC".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(name: &str, settings: Option<&str>) -> Config {
        let root = std::env::temp_dir().join(format!("ro-timezone-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("state")).unwrap();
        if let Some(body) = settings {
            fs::write(root.join("state/settings.json"), body).unwrap();
        }
        Config {
            root: root.join("app"),
            state: root.join("state"),
            nebula_home: root.join("nebula"),
            nebula: root.join("unused"),
            docker: root.join("unused"),
            image: String::new(),
            db_image: String::new(),
            app_version: None,
            ports: crate::ports::Ports::DEFAULT,
        }
    }

    #[test]
    fn zone_names_are_checked_before_they_reach_a_command_line() {
        for ok in ["UTC", "Europe/Berlin", "America/Argentina/Buenos_Aires", "Etc/GMT+5", "Etc/GMT-14", "America/Port-au-Prince"] {
            assert!(valid(ok), "{ok}");
        }
        for bad in ["", "Europe/", "/UTC", "Europe/Berlin; rm -rf /", "UTC TZ=x", "../etc/passwd", "a/b/c/d", "1Europe", &"A".repeat(65)] {
            assert!(!valid(bad), "{bad}");
        }
    }

    #[test]
    fn a_chosen_zone_is_used_and_a_damaged_one_is_refused() {
        let cfg = fixture("chosen", Some(r#"{"server_timezone":"Asia/Tokyo"}"#));
        assert_eq!(chosen(&cfg).unwrap(), "Asia/Tokyo");
        let cfg = fixture("utc", Some(r#"{"server_timezone":"UTC"}"#));
        assert_eq!(chosen(&cfg).unwrap(), "UTC");
        for body in [r#"{"server_timezone":"Asia/To kyo"}"#, r#"{"server_timezone":9}"#, r#"{"server_timezone":true}"#] {
            let cfg = fixture("damaged", Some(body));
            assert_eq!(chosen(&cfg).unwrap_err(), ERROR, "{body}");
        }
    }

    #[test]
    fn following_the_computer_without_the_shell_is_utc() {
        // The variable is the shell's; a test run has none unless someone set
        // it, and then it must at least be a zone.
        let expected = std::env::var(HOST_VAR).ok().filter(|z| valid(z)).unwrap_or_else(|| "UTC".into());
        for body in [None, Some("{}"), Some(r#"{"server_timezone":null}"#)] {
            let cfg = fixture("host", body);
            assert_eq!(chosen(&cfg).unwrap(), expected);
        }
    }
}
