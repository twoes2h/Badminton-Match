const { performance } = require('perf_hooks');

const baseUrl = (process.env.ONLINE_TEST_BASE_URL || process.argv[2] || 'http://127.0.0.1:3000').replace(/\/$/, '');
const concurrency = Math.max(1, Number(process.env.ONLINE_TEST_CONCURRENCY || process.argv[3] || 120));
const rounds = Math.max(1, Number(process.env.ONLINE_TEST_ROUNDS || process.argv[4] || 3));
const path = process.env.ONLINE_TEST_PATH || '/api/healthz';
const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

async function requestOnce() {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' }
    });
    await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      ms: performance.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ms: performance.now() - startedAt,
      error: error.message
    };
  }
}

async function main() {
  const results = [];
  const startedAt = performance.now();
  for (let round = 0; round < rounds; round += 1) {
    const batch = await Promise.all(Array.from({ length: concurrency }, requestOnce));
    results.push(...batch);
    const ok = batch.filter((item) => item.ok).length;
    console.log(`round ${round + 1}/${rounds}: ${ok}/${batch.length} ok`);
  }

  const totalMs = performance.now() - startedAt;
  const ok = results.filter((item) => item.ok).length;
  const failed = results.length - ok;
  const latencies = results.filter((item) => item.ok).map((item) => item.ms);
  const statuses = results.reduce((map, item) => {
    map[item.status] = (map[item.status] || 0) + 1;
    return map;
  }, {});

  console.log(JSON.stringify({
    url,
    concurrency,
    rounds,
    requests: results.length,
    ok,
    failed,
    statuses,
    p50Ms: Math.round(percentile(latencies, 0.5)),
    p95Ms: Math.round(percentile(latencies, 0.95)),
    maxMs: Math.round(Math.max(0, ...latencies)),
    totalMs: Math.round(totalMs),
    requestsPerSecond: Math.round((results.length / totalMs) * 1000)
  }, null, 2));

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
