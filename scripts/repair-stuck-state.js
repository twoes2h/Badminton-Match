const { pool } = require('../src/db');
const { repairStuckState, healthSnapshot } = require('../src/services/health');

(async () => {
  const before = await healthSnapshot({ strict: true }).catch((error) => ({
    ok: false,
    error: error.message
  }));
  const repaired = await repairStuckState();
  const after = await healthSnapshot({ strict: true }).catch((error) => ({
    ok: false,
    error: error.message
  }));
  console.log(JSON.stringify({ before, repaired, after }));
  await pool.end();
})().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
