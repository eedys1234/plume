//! 배포 설정(AWS 자격증명 포함)의 로컬 암호화 저장.
//!
//! - 저장 위치: 앱 설정 디렉터리(`app_config_dir/deploy/*.enc`) — 워크스페이스/깃 밖.
//! - 암호화: AES-256-GCM. 12바이트 난스를 암호문 앞에 붙여 파일로 기록.
//! - 키: OS 키체인(Windows 자격 증명 관리자 / macOS Keychain / Linux Secret Service)에 보관.
//!   키체인 사용이 불가하면 설정 디렉터리의 `key.bin`으로 폴백(항상 동작 보장).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use std::path::PathBuf;
use tauri::Manager;

const SERVICE: &str = "plume-deploy";
const KEY_USER: &str = "config-key";

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("deploy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn rand_bytes(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    getrandom::getrandom(&mut v).expect("OS RNG 사용 가능해야 함");
    v
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}
fn to32(b: &[u8]) -> [u8; 32] {
    let mut a = [0u8; 32];
    a.copy_from_slice(&b[..32]);
    a
}

/// 32바이트 대칭키 확보: 키체인 우선, 실패 시 설정 디렉터리의 key.bin.
fn get_or_create_key(app: &tauri::AppHandle) -> Result<[u8; 32], String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, KEY_USER) {
        match entry.get_password() {
            Ok(h) => {
                if let Some(b) = unhex(&h) {
                    if b.len() == 32 {
                        return Ok(to32(&b));
                    }
                }
            }
            Err(keyring::Error::NoEntry) => {
                let k = rand_bytes(32);
                if entry.set_password(&hex(&k)).is_ok() {
                    return Ok(to32(&k));
                }
            }
            Err(_) => { /* 키체인 사용 불가 → 파일 폴백 */ }
        }
    }
    // 파일 폴백.
    let kf = app_dir(app)?.join("key.bin");
    if let Ok(b) = std::fs::read(&kf) {
        if b.len() == 32 {
            return Ok(to32(&b));
        }
    }
    let k = rand_bytes(32);
    std::fs::write(&kf, &k).map_err(|e| e.to_string())?;
    Ok(to32(&k))
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect()
}
fn file_for(app: &tauri::AppHandle, project: &str) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join(format!("{}.enc", sanitize(project))))
}

/// 평문 JSON을 암호화해 파일로 저장.
pub fn save(app: &tauri::AppHandle, project: &str, json: &str) -> Result<(), String> {
    let key = get_or_create_key(app)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce_bytes = rand_bytes(12);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), json.as_bytes())
        .map_err(|e| format!("암호화 실패: {e}"))?;
    let mut out = nonce_bytes;
    out.extend_from_slice(&ct);
    std::fs::write(file_for(app, project)?, out).map_err(|e| e.to_string())?;
    Ok(())
}

/// 파일을 복호화해 평문 JSON 반환(없으면 None).
pub fn load(app: &tauri::AppHandle, project: &str) -> Result<Option<String>, String> {
    let path = file_for(app, project)?;
    let data = match std::fs::read(&path) {
        Ok(d) => d,
        Err(_) => return Ok(None),
    };
    if data.len() < 12 {
        return Ok(None);
    }
    let key = get_or_create_key(app)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let (nonce_bytes, ct) = data.split_at(12);
    let pt = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct)
        .map_err(|e| format!("복호화 실패(키 불일치 가능): {e}"))?;
    Ok(Some(String::from_utf8_lossy(&pt).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 키를 직접 넣어 암·복호화 왕복만 검증(키체인/파일 IO 제외 순수 로직).
    fn roundtrip(key: &[u8; 32], plaintext: &str) -> String {
        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let nonce_bytes = [7u8; 12];
        let ct = cipher.encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes()).unwrap();
        let mut blob = nonce_bytes.to_vec();
        blob.extend_from_slice(&ct);
        let (nb, c) = blob.split_at(12);
        let pt = cipher.decrypt(Nonce::from_slice(nb), c).unwrap();
        String::from_utf8(pt).unwrap()
    }

    #[test]
    fn aes_gcm_roundtrip() {
        let key = [42u8; 32];
        let msg = r#"{"bucket":"b","secretAccessKey":"s3cr3t"}"#;
        assert_eq!(roundtrip(&key, msg), msg);
    }

    #[test]
    fn wrong_key_fails() {
        let cipher = Aes256Gcm::new_from_slice(&[1u8; 32]).unwrap();
        let nb = [7u8; 12];
        let ct = cipher.encrypt(Nonce::from_slice(&nb), b"hi".as_ref()).unwrap();
        let other = Aes256Gcm::new_from_slice(&[2u8; 32]).unwrap();
        assert!(other.decrypt(Nonce::from_slice(&nb), ct.as_ref()).is_err());
    }

    #[test]
    fn hex_unhex_roundtrip() {
        let b = [0u8, 15, 16, 255, 128];
        assert_eq!(unhex(&hex(&b)).unwrap(), b);
    }
}
