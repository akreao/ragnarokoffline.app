//! Account passwords as the login server stores them: PBKDF2-HMAC-SHA256,
//!
//!   `$pbkdf2-sha256$<iterations>$<salt, base64>$<hash, base64>`
//!
//! in `login.user_pass`, with `login.pass_flags` recording what the plain text
//! was like (weak? the shipped default?) so checks still work once it is gone.
//!
//! This must match the rAthena fork's src/login/password.cpp byte for byte:
//! 200000 iterations, a 16-byte salt, one 32-byte PBKDF2 block, base64 with
//! the standard alphabet and no padding. The app writes the hash itself, so no
//! plain-text password sits in the database waiting for the login server
//! (which only converts once, at start-up, for worlds from before hashing).
//! SHA-256 is archive.rs's; HMAC and PBKDF2 are written out here, like the
//! rest of this crate, rather than pulling in a dependency.

use crate::archive::Sha256;

const PREFIX: &str = "$pbkdf2-sha256$";
/// The login server's count. Tests hash with far fewer, or a few hundred
/// thousand HMACs per account statement are most of `cargo test`;
/// matches_the_login_servers_hash_byte_for_byte still checks this one.
const SERVER_ITERATIONS: u32 = 200_000;
#[cfg(not(test))]
pub(crate) const ITERATIONS: u32 = SERVER_ITERATIONS;
#[cfg(test)]
pub(crate) const ITERATIONS: u32 = 1_000;
const SALT_BYTES: usize = 16;

/// `pass_flags` bits (password.hpp's e_password_flag).
pub const WEAK: u8 = 0x01;
pub const DEFAULT: u8 = 0x02;

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// HMAC-SHA256 with the key's padded blocks absorbed once, so each MAC after
/// that costs two compressions.
struct Hmac {
    inner: Sha256,
    outer: Sha256,
}

impl Hmac {
    fn new(key: &[u8]) -> Self {
        let mut k = [0u8; 64];
        if key.len() > 64 {
            let mut h = Sha256::new();
            h.update(key);
            k[..32].copy_from_slice(&h.digest());
        } else {
            k[..key.len()].copy_from_slice(key);
        }
        let (mut inner, mut outer) = (Sha256::new(), Sha256::new());
        inner.update(&k.map(|b| b ^ 0x36));
        outer.update(&k.map(|b| b ^ 0x5c));
        Hmac { inner, outer }
    }

    fn mac(&self, data: &[u8]) -> [u8; 32] {
        let mut inner = self.inner.clone();
        inner.update(data);
        let mut outer = self.outer.clone();
        outer.update(&inner.digest());
        outer.digest()
    }
}

/// PBKDF2-HMAC-SHA256, first (and only) 32-byte block.
fn pbkdf2(plain: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let hmac = Hmac::new(plain);
    let mut first = salt.to_vec();
    first.extend_from_slice(&[0, 0, 0, 1]);
    let mut u = hmac.mac(&first);
    let mut out = u;
    for _ in 1..iterations {
        u = hmac.mac(&u);
        for (o, b) in out.iter_mut().zip(u) {
            *o ^= b;
        }
    }
    out
}

fn b64encode(data: &[u8]) -> String {
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64[n as usize & 63] as char);
        }
    }
    out
}

fn format(salt: &[u8], iterations: u32, plain: &str) -> String {
    let hash = pbkdf2(plain.as_bytes(), salt, iterations);
    format!("{PREFIX}{iterations}${}${}", b64encode(salt), b64encode(&hash))
}

/// What `login.user_pass` holds for `plain`, with a fresh salt from the OS.
pub fn hash(plain: &str) -> Result<String, String> {
    let salt = crate::private_fs::random_bytes(SALT_BYTES)?;
    Ok(format(&salt, ITERATIONS, plain))
}

/// `login.pass_flags` for `plain` on account `userid`: password::flags in the
/// fork. Weak is not 8-23 printable ASCII bytes, blank after trimming spaces,
/// or the account name ignoring ASCII case; default is exactly "ragnarok".
pub fn flags(plain: &str, userid: &str) -> u8 {
    let mut out = 0;
    let bytes = plain.as_bytes();
    if !(8..=23).contains(&bytes.len())
        || !bytes.iter().all(|b| (0x20..=0x7e).contains(b))
        || bytes.iter().all(|&b| b == b' ')
        || plain.eq_ignore_ascii_case(userid)
    {
        out |= WEAK;
    }
    if plain == "ragnarok" {
        out |= DEFAULT;
    }
    out
}

/// The two column values for a new password: `user_pass` and `pass_flags`,
/// hex-encoded like every other value this crate puts in a statement.
pub fn columns(plain: &str, userid: &str) -> Result<(String, u8), String> {
    Ok((crate::accounts::hex(&hash(plain)?), flags(plain, userid)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hexs(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn b64decode(s: &str) -> Option<Vec<u8>> {
        let (mut n, mut bits, mut out) = (0u32, 0, Vec::new());
        for c in s.bytes() {
            n = (n << 6) | B64.iter().position(|&a| a == c)? as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((n >> bits) as u8);
            }
        }
        Some(out)
    }

    /// password::verify from the fork, written from its source: the format is
    /// parsed the same way, so a stored value this accepts is one it accepts.
    fn verify(plain: &str, stored: &str) -> bool {
        let Some(rest) = stored.strip_prefix(PREFIX) else { return false };
        let parts: Vec<&str> = rest.splitn(3, '$').collect();
        let [iterations, salt, expected] = parts[..] else { return false };
        let Ok(iterations) = iterations.parse::<u32>() else { return false };
        let (Some(salt), Some(expected)) = (b64decode(salt), b64decode(expected)) else { return false };
        iterations > 0 && expected.len() == 32 && pbkdf2(plain.as_bytes(), &salt, iterations)[..] == expected[..]
    }

    #[test]
    fn sha256_known_answers() {
        // FIPS 180-4 examples, and the two-block padding edge (56 bytes).
        let digest = |data: &[u8]| {
            let mut h = Sha256::new();
            h.update(data);
            hexs(&h.digest())
        };
        assert_eq!(digest(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(digest(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(digest(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    }

    #[test]
    fn hmac_known_answers() {
        // RFC 4231 test cases 1 and 6 (a key longer than a block is hashed).
        assert_eq!(hexs(&Hmac::new(&[0x0b; 20]).mac(b"Hi There")), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
        assert_eq!(
            hexs(&Hmac::new(&[0xaa; 131]).mac(b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn pbkdf2_known_answers() {
        // RFC 7914 section 11 (the first 32 bytes of each 64-byte output), and
        // the widely published PBKDF2-HMAC-SHA256 counterparts of RFC 6070's.
        assert_eq!(hexs(&pbkdf2(b"passwd", b"salt", 1)), "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
        assert_eq!(hexs(&pbkdf2(b"password", b"salt", 4096)), "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
        assert_eq!(
            hexs(&pbkdf2(b"passwordPASSWORDpassword", b"saltSALTsaltSALTsaltSALTsaltSALTsalt", 4096)),
            "348c89dbcbd32b2f32d814b8116e84cf2b17347ebc1800181c4e2a1fb8dd53e1"
        );
        assert_eq!(hexs(&pbkdf2(b"Password", b"NaCl", 80000)), "4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56");
    }

    #[test]
    fn base64_is_standard_and_unpadded() {
        assert_eq!(b64encode(b""), "");
        assert_eq!(b64encode(b"f"), "Zg");
        assert_eq!(b64encode(b"fo"), "Zm8");
        assert_eq!(b64encode(b"foo"), "Zm9v");
        assert_eq!(b64encode(&[0xfb, 0xff]), "+/8");
    }

    // Produced by the fork's own password.cpp at 74026199 (a harness that
    // includes it and calls its pbkdf2/b64encode with this fixed salt), so a
    // byte of difference in iterations, salt, encoding or layout fails here.
    const FORK_SALT: [u8; 16] = *b"0123456789abcdef";
    const FORK_HASH: &str = "$pbkdf2-sha256$200000$MDEyMzQ1Njc4OWFiY2RlZg$PMD+rWJ5/Ba5tdeCkVDRPtVOgxnhwmrsIpbmMCYhaNM";
    // password::hash itself, random salt and all.
    const FORK_RANDOM: &str = "$pbkdf2-sha256$200000$k9u6h2ed1/pKsguV0Fh5mg$cP1ZpKT8RHglwlDTgrT2RBYlFJWovYvMWmI363nzU+k";

    // One hash at the server's count per test, so they run side by side: an
    // unoptimised 200,000-iteration PBKDF2 takes about a second each.
    #[test]
    fn matches_the_login_servers_hash_byte_for_byte() {
        assert_eq!(format(&FORK_SALT, SERVER_ITERATIONS, "hunter2-secret"), FORK_HASH);
    }

    #[test]
    fn accepts_a_hash_the_login_server_wrote() {
        assert!(verify("hunter2-secret", FORK_RANDOM));
    }

    #[test]
    fn a_new_hash_has_the_servers_shape_and_a_fresh_salt() {
        let one = hash("hunter2-secret").unwrap();
        let two = hash("hunter2-secret").unwrap();
        assert_ne!(one, two);
        let parts: Vec<&str> = one.split('$').collect();
        // "", "pbkdf2-sha256", iterations, salt, hash
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[2], ITERATIONS.to_string());
        assert_eq!(b64decode(parts[3]).unwrap().len(), 16);
        assert_eq!(parts[3].len(), 22);
        assert_eq!(parts[4].len(), 43);
        assert!(one.len() <= 128, "fits user_pass varchar(128)");
        assert!(verify("hunter2-secret", &one) && !verify("hunter2-secre", &one));
    }

    #[test]
    fn flags_follow_the_fork() {
        assert_eq!(flags("ragnarok", "someone"), DEFAULT);
        assert_eq!(flags("ragnarok", "RAGNAROK"), DEFAULT | WEAK);
        assert_eq!(flags("good-password", "someone"), 0);
        assert_eq!(flags("short", "someone"), WEAK);
        assert_eq!(flags("abcdefghijklmnopqrstuvwx", "someone"), WEAK); // 24
        assert_eq!(flags("abcdefghijklmnopqrstuvw", "someone"), 0); // 23
        assert_eq!(flags("        ", "someone"), WEAK);
        assert_eq!(flags("pässwörd1", "someone"), WEAK);
        assert_eq!(flags("Someone1", "someONE1"), WEAK);
    }
}
