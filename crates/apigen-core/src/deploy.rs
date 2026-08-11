//! CloudFront(S3 오리진) 배포 — GitHub Actions의 `aws s3 cp` + `aws cloudfront create-invalidation`
//! 흐름을 데스크톱에서 재현한다.
//!
//! - async AWS SDK 대신 **AWS SigV4 를 직접 서명**하고 blocking reqwest 로 요청한다
//!   (코어를 동기로 유지 + 무거운 SDK 의존 회피).
//! - 배포 대상: 생성된 문서 HTML(Redoc/Swagger) 한 개를 S3 오브젝트로 PUT → CloudFront 무효화.
//! - 자격증명(access key/secret)은 호출자가 그때그때 넘긴다(디스크에 두지 않음).

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{CoreError, Result};

type HmacSha256 = Hmac<Sha256>;

/// AWS 자격증명(사용자 입력).
#[derive(Clone)]
pub struct AwsCreds {
    pub access_key_id: String,
    pub secret_access_key: String,
    /// STS 임시 자격증명일 때만(선택). 있으면 x-amz-security-token 헤더로 서명·전송.
    pub session_token: Option<String>,
}

/// CloudFront 배포 설정.
pub struct DeployConfig {
    pub region: String,          // 예: ap-northeast-2
    pub bucket: String,          // S3 버킷명
    pub key: String,             // 오브젝트 키 (예: index.html, docs/index.html)
    pub distribution_id: String, // CloudFront 배포 ID
    pub invalidation_path: String, // 무효화 경로 (예: /*, /index.html)
    /// (선택) 이 역할을 assume해 임시 자격증명으로 배포. 비면 기본 자격증명 직접 사용.
    pub role_arn: String,
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}
fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}
fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

/// AWS 규칙의 퍼센트 인코딩. 비예약문자(A-Za-z0-9-_.~)만 통과, 나머지는 %HH.
/// `encode_slash=false`면 '/'는 인코딩하지 않는다(경로용).
fn uri_encode(s: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let keep = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') || (b == b'/' && !encode_slash);
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// SystemTime → (amzdate "YYYYMMDDTHHMMSSZ", datestamp "YYYYMMDD").
fn timestamps(now: SystemTime) -> (String, String) {
    let secs = now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, mo, d, h, mi, s) = civil_from_epoch(secs);
    (
        format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z"),
        format!("{y:04}{mo:02}{d:02}"),
    )
}

/// epoch 초 → (년, 월, 일, 시, 분, 초) UTC. (Howard Hinnant civil_from_days)
fn civil_from_epoch(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86400) as i64;
    let rem = (secs % 86400) as i64;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if m <= 2 { y + 1 } else { y };
    (year, m as u32, d as u32, h as u32, mi as u32, s as u32)
}

/// SigV4 Authorization 헤더 값을 만든다(순수 함수 → 테스트 가능).
/// `headers`는 **서명 대상** 헤더 전체(소문자 키). 최소 host, x-amz-date 포함.
#[allow(clippy::too_many_arguments)]
fn authorization(
    method: &str,
    uri: &str,
    query: &str,
    headers: &BTreeMap<String, String>,
    payload_hash: &str,
    region: &str,
    service: &str,
    amz_date: &str,
    date_stamp: &str,
    creds: &AwsCreds,
) -> String {
    // 1) Canonical headers / signed headers
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{}\n", v.trim())).collect();
    let signed_headers: String = headers.keys().cloned().collect::<Vec<_>>().join(";");

    // 2) Canonical request
    let canonical_request = format!(
        "{method}\n{uri}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    // 3) String to sign
    let scope = format!("{date_stamp}/{region}/{service}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    // 4) Signing key
    let k_date = hmac(format!("AWS4{}", creds.secret_access_key).as_bytes(), date_stamp.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    let k_signing = hmac(&k_service, b"aws4_request");
    let signature = hex(&hmac(&k_signing, string_to_sign.as_bytes()));

    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        creds.access_key_id
    )
}

/// 서명된 요청을 만들어 전송한다. (method: GET/PUT/POST 등)
#[allow(clippy::too_many_arguments)]
fn signed_send(
    method: &str,
    host: &str,
    region: &str,
    service: &str,
    uri: &str,
    query: &str,
    content_type: Option<&str>,
    body: &[u8],
    creds: &AwsCreds,
    now: SystemTime,
) -> Result<(u16, String)> {
    let (amz_date, date_stamp) = timestamps(now);
    let payload_hash = sha256_hex(body);

    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    headers.insert("host".into(), host.into());
    headers.insert("x-amz-content-sha256".into(), payload_hash.clone());
    headers.insert("x-amz-date".into(), amz_date.clone());
    if let Some(ct) = content_type {
        headers.insert("content-type".into(), ct.into());
    }
    if let Some(tok) = &creds.session_token {
        headers.insert("x-amz-security-token".into(), tok.clone());
    }

    let auth = authorization(method, uri, query, &headers, &payload_hash, region, service, &amz_date, &date_stamp, creds);

    let url = if query.is_empty() {
        format!("https://{host}{uri}")
    } else {
        format!("https://{host}{uri}?{query}")
    };

    let client = reqwest::blocking::Client::new();
    let mut req = match method {
        "PUT" => client.put(&url),
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    req = req.header("Authorization", auth);
    for (k, v) in &headers {
        if k == "host" {
            continue; // reqwest가 host를 자동 설정
        }
        req = req.header(k.as_str(), v.as_str());
    }
    req = req.body(body.to_vec());

    let resp = req.send().map_err(|e| CoreError::Http(format!("요청 실패: {e}")))?;
    let status = resp.status().as_u16();
    let text = resp.text().unwrap_or_default();
    Ok((status, text))
}

/// S3 PutObject (virtual-hosted-style). key는 슬래시 유지 인코딩.
fn s3_put_object(
    creds: &AwsCreds,
    region: &str,
    bucket: &str,
    key: &str,
    content_type: &str,
    body: &[u8],
    now: SystemTime,
) -> Result<()> {
    let host = format!("{bucket}.s3.{region}.amazonaws.com");
    let key_trimmed = key.trim_start_matches('/');
    let uri = format!("/{}", uri_encode(key_trimmed, false));
    let (status, text) = signed_send("PUT", &host, region, "s3", &uri, "", Some(content_type), body, creds, now)?;
    if !(200..300).contains(&status) {
        return Err(CoreError::Http(format!("S3 업로드 실패({status}): {}", text.trim())));
    }
    Ok(())
}

/// CloudFront CreateInvalidation. 성공 시 무효화 ID 반환.
fn cloudfront_invalidate(
    creds: &AwsCreds,
    distribution_id: &str,
    paths: &[String],
    now: SystemTime,
) -> Result<String> {
    let caller_ref = format!(
        "plume-{}",
        now.duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    );
    let items: String = paths.iter().map(|p| format!("<Path>{}</Path>", xml_escape(p))).collect();
    let body = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><Paths><Quantity>{}</Quantity><Items>{items}</Items></Paths><CallerReference>{caller_ref}</CallerReference></InvalidationBatch>"#,
        paths.len()
    );
    let uri = format!("/2020-05-31/distribution/{distribution_id}/invalidation");
    // CloudFront는 글로벌 서비스 → us-east-1 로 서명.
    let (status, text) = signed_send(
        "POST",
        "cloudfront.amazonaws.com",
        "us-east-1",
        "cloudfront",
        &uri,
        "",
        Some("text/xml"),
        body.as_bytes(),
        creds,
        now,
    )?;
    if !(200..300).contains(&status) {
        return Err(CoreError::Http(format!("CloudFront 무효화 실패({status}): {}", text.trim())));
    }
    // <Id>...</Id> 추출(간단 파싱).
    let id = text
        .split_once("<Id>")
        .and_then(|(_, r)| r.split_once("</Id>"))
        .map(|(id, _)| id.to_string())
        .unwrap_or_else(|| "(id 파싱 실패)".into());
    Ok(id)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// XML에서 `<tag>...</tag>` 첫 값 추출.
fn xml_pick(text: &str, tag: &str) -> Option<String> {
    text.split_once(&format!("<{tag}>"))
        .and_then(|(_, r)| r.split_once(&format!("</{tag}>")))
        .map(|(v, _)| v.to_string())
}

/// STS AssumeRole: 기본 자격증명으로 역할을 assume해 임시 자격증명을 받는다.
/// GitHub Actions의 `aws-actions/configure-aws-credentials` role-to-assume 와 동일 개념.
pub fn sts_assume_role(base: &AwsCreds, role_arn: &str, session_name: &str, now: SystemTime) -> Result<AwsCreds> {
    let body = format!(
        "Action=AssumeRole&Version=2011-06-15&RoleArn={}&RoleSessionName={}&DurationSeconds=3600",
        uri_encode(role_arn, true),
        uri_encode(session_name, true),
    );
    // STS 글로벌 엔드포인트(sts.amazonaws.com)는 us-east-1 로 서명한다.
    let (status, text) = signed_send(
        "POST", "sts.amazonaws.com", "us-east-1", "sts",
        "/", "", Some("application/x-www-form-urlencoded"),
        body.as_bytes(), base, now,
    )?;
    if !(200..300).contains(&status) {
        return Err(CoreError::Http(format!("STS AssumeRole 실패({status}): {}", text.trim())));
    }
    let access_key_id = xml_pick(&text, "AccessKeyId")
        .ok_or_else(|| CoreError::Http("STS 응답에 AccessKeyId 없음".into()))?;
    let secret_access_key = xml_pick(&text, "SecretAccessKey")
        .ok_or_else(|| CoreError::Http("STS 응답에 SecretAccessKey 없음".into()))?;
    let session_token = xml_pick(&text, "SessionToken");
    Ok(AwsCreds { access_key_id, secret_access_key, session_token })
}

/// 원클릭 배포: 문서 HTML을 S3에 올리고 CloudFront를 무효화한다. 사람이 읽을 로그 반환.
pub fn deploy_cloudfront(creds: &AwsCreds, cfg: &DeployConfig, html: &str) -> Result<String> {
    if creds.access_key_id.trim().is_empty() || creds.secret_access_key.trim().is_empty() {
        return Err(CoreError::Http("AWS Access Key / Secret 을 입력하세요".into()));
    }
    if cfg.bucket.trim().is_empty() {
        return Err(CoreError::Http("S3 버킷명을 입력하세요".into()));
    }
    let now = SystemTime::now();
    let mut log = String::new();

    // Role ARN 이 있으면 먼저 AssumeRole 로 임시 자격증명을 받아 그걸로 배포한다.
    let effective;
    let creds = if !cfg.role_arn.trim().is_empty() {
        effective = sts_assume_role(creds, cfg.role_arn.trim(), "plume-deploy", now)?;
        log.push_str(&format!("✓ 역할 assume: {}\n", cfg.role_arn.trim()));
        &effective
    } else {
        creds
    };

    s3_put_object(creds, &cfg.region, &cfg.bucket, &cfg.key, "text/html; charset=utf-8", html.as_bytes(), now)?;
    log.push_str(&format!(
        "✓ S3 업로드: s3://{}/{} ({} bytes)\n",
        cfg.bucket,
        cfg.key.trim_start_matches('/'),
        html.len()
    ));

    if cfg.distribution_id.trim().is_empty() {
        log.push_str("• CloudFront 배포 ID 없음 → 무효화 건너뜀\n");
        return Ok(log);
    }
    let path = if cfg.invalidation_path.trim().is_empty() { "/*".to_string() } else { cfg.invalidation_path.clone() };
    let inv_id = cloudfront_invalidate(creds, &cfg.distribution_id, &[path.clone()], now)?;
    log.push_str(&format!("✓ CloudFront 무효화 요청: {} (경로 {path}, ID {inv_id})\n", cfg.distribution_id));
    log.push_str("→ 무효화 완료까지 수십 초~수 분 소요될 수 있습니다.");
    Ok(log)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_epoch_matches_known_date() {
        // 1440938160 = 2015-08-30T12:36:00Z (AWS SigV4 테스트 벡터 날짜)
        assert_eq!(civil_from_epoch(1440938160), (2015, 8, 30, 12, 36, 0));
        // epoch 0
        assert_eq!(civil_from_epoch(0), (1970, 1, 1, 0, 0, 0));
        // 2000-03-01 (윤년 경계 다음날)
        assert_eq!(civil_from_epoch(951868800), (2000, 3, 1, 0, 0, 0));
    }

    #[test]
    fn xml_pick_extracts_sts_credentials() {
        let xml = r#"<AssumeRoleResult><Credentials><AccessKeyId>ASIA123</AccessKeyId><SecretAccessKey>sec/ret</SecretAccessKey><SessionToken>tok==</SessionToken></Credentials></AssumeRoleResult>"#;
        assert_eq!(xml_pick(xml, "AccessKeyId").as_deref(), Some("ASIA123"));
        assert_eq!(xml_pick(xml, "SecretAccessKey").as_deref(), Some("sec/ret"));
        assert_eq!(xml_pick(xml, "SessionToken").as_deref(), Some("tok=="));
        assert_eq!(xml_pick(xml, "Nope"), None);
    }

    #[test]
    fn uri_encode_rules() {
        assert_eq!(uri_encode("docs/index.html", false), "docs/index.html");
        assert_eq!(uri_encode("docs/index.html", true), "docs%2Findex.html");
        assert_eq!(uri_encode("a b+c", false), "a%20b%2Bc");
        assert_eq!(uri_encode("keep-_.~", false), "keep-_.~");
    }

    #[test]
    fn sigv4_matches_aws_get_vanilla_vector() {
        // AWS SigV4 공식 테스트 스위트의 'get-vanilla' 케이스.
        let creds = AwsCreds {
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
        };
        let mut headers = BTreeMap::new();
        headers.insert("host".to_string(), "example.amazonaws.com".to_string());
        headers.insert("x-amz-date".to_string(), "20150830T123600Z".to_string());
        let payload_hash = sha256_hex(b"");
        let auth = authorization(
            "GET", "/", "", &headers, &payload_hash,
            "us-east-1", "service", "20150830T123600Z", "20150830", &creds,
        );
        assert!(
            auth.contains("Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"),
            "unexpected auth: {auth}"
        );
        assert!(auth.contains("SignedHeaders=host;x-amz-date"));
        assert!(auth.contains("Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request"));
    }
}
