//! 부하 테스트(Postman/k6 유사): 한 요청을 동시성 N으로 반복 호출해 지연·처리량 통계를 낸다.
//!
//! `http::send`가 blocking이라 스레드 풀로 동시 실행한다. 지연(latency)은 각 요청의
//! 실제 왕복 시간(http::send가 측정)만 집계하고, rps는 전체 벽시계 기준.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::http::{send, Environment, HttpRequest};

#[derive(Debug, Clone, Deserialize)]
pub struct LoadOptions {
    /// 총 요청 수.
    pub iterations: usize,
    /// 동시 실행 수(가상 사용자).
    pub concurrency: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadResult {
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub min_ms: u128,
    pub max_ms: u128,
    pub avg_ms: f64,
    pub p50_ms: u128,
    pub p95_ms: u128,
    pub p99_ms: u128,
    pub rps: f64,
    pub elapsed_ms: u128,
    /// (상태코드, 개수) 정렬 목록.
    pub status_counts: Vec<(u16, usize)>,
}

/// 정렬된 지연 배열에서 백분위(0.0~1.0) 값.
fn percentile(sorted: &[u128], p: f64) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((p * (sorted.len() - 1) as f64).round() as usize).min(sorted.len() - 1);
    sorted[idx]
}

/// 단일 요청 부하 테스트.
pub fn run_load(req: &HttpRequest, env: &Environment, opts: &LoadOptions) -> Result<LoadResult> {
    run_load_group(std::slice::from_ref(req), env, opts)
}

/// 그룹(여러 요청) 부하 테스트. 각 반복은 요청들을 라운드로빈으로 하나씩 호출한다.
pub fn run_load_group(reqs: &[HttpRequest], env: &Environment, opts: &LoadOptions) -> Result<LoadResult> {
    let iterations = opts.iterations.max(1);
    let concurrency = opts.concurrency.clamp(1, 64);
    if reqs.is_empty() {
        return Err(crate::error::CoreError::Http("요청이 없습니다".into()));
    }

    let counter = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicUsize::new(0));
    let latencies = Arc::new(Mutex::new(Vec::<u128>::with_capacity(iterations)));
    let statuses = Arc::new(Mutex::new(HashMap::<u16, usize>::new()));

    let started = Instant::now();
    let mut handles = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        let (counter, failed, latencies, statuses) =
            (counter.clone(), failed.clone(), latencies.clone(), statuses.clone());
        let reqs = reqs.to_vec();
        let env = env.clone();
        handles.push(thread::spawn(move || loop {
            let i = counter.fetch_add(1, Ordering::SeqCst);
            if i >= iterations {
                break;
            }
            let req = &reqs[i % reqs.len()]; // 라운드로빈
            match send(req, &env) {
                Ok(resp) => {
                    latencies.lock().unwrap().push(resp.elapsed_ms);
                    *statuses.lock().unwrap().entry(resp.status).or_insert(0) += 1;
                }
                Err(_) => {
                    failed.fetch_add(1, Ordering::SeqCst);
                }
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
    let elapsed_ms = started.elapsed().as_millis();

    let mut lats = Arc::try_unwrap(latencies).unwrap().into_inner().unwrap();
    lats.sort_unstable();
    let success = lats.len();
    let failed = failed.load(Ordering::SeqCst);
    let total = success + failed;
    let sum: u128 = lats.iter().sum();
    let avg_ms = if success > 0 { sum as f64 / success as f64 } else { 0.0 };

    let mut status_counts: Vec<(u16, usize)> =
        Arc::try_unwrap(statuses).unwrap().into_inner().unwrap().into_iter().collect();
    status_counts.sort_unstable();

    Ok(LoadResult {
        total,
        success,
        failed,
        min_ms: *lats.first().unwrap_or(&0),
        max_ms: *lats.last().unwrap_or(&0),
        avg_ms,
        p50_ms: percentile(&lats, 0.50),
        p95_ms: percentile(&lats, 0.95),
        p99_ms: percentile(&lats, 0.99),
        rps: if elapsed_ms > 0 { total as f64 / (elapsed_ms as f64 / 1000.0) } else { 0.0 },
        elapsed_ms,
        status_counts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles() {
        let v: Vec<u128> = (1..=100).collect(); // 값 1..100, 인덱스 0..99
        // idx = round(p*(n-1)); v[idx] = idx+1
        assert_eq!(percentile(&v, 0.50), 51); // round(49.5)=50 → v[50]=51
        assert_eq!(percentile(&v, 0.95), 95); // round(94.05)=94 → v[94]=95
        assert_eq!(percentile(&v, 0.99), 99); // round(98.01)=98 → v[98]=99
        assert_eq!(percentile(&v, 0.0), 1);
        assert_eq!(percentile(&v, 1.0), 100);
        assert_eq!(percentile(&[], 0.5), 0);
    }
}
