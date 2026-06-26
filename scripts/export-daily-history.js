const fs = require('fs');
const path = require('path');
const { query, pool } = require('../src/db');

function targetDate() {
  const arg = process.argv[2];
  if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const day = targetDate();
  const rows = await query(
    `SELECT
       m.id AS match_id,
       m.room_id,
       r.code AS room_code,
       r.name AS room_name,
       r.status AS room_status,
       m.sport_key,
       m.match_type,
       m.court_no,
       m.round_no,
       m.status AS match_status,
       m.result_winner,
       m.score_red,
       m.score_blue,
       m.invalid_reason,
       m.started_at,
       m.ended_at,
       m.finalized_at,
       mp.user_id,
       u.display_name,
       u.gender,
       mp.team,
       mp.rating_before,
       mp.rating_after,
       mr.outcome,
       mr.score_red AS submitted_score_red,
       mr.score_blue AS submitted_score_blue,
       mr.submitted_at
     FROM matches m
     JOIN rooms r ON r.id = m.room_id
     JOIN match_players mp ON mp.match_id = m.id
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN match_results mr
       ON mr.match_id = m.id
      AND mr.user_id = mp.user_id
     WHERE DATE(m.started_at) = ?
     ORDER BY m.started_at, m.id, mp.team, mp.id`,
    [day]
  );

  const dir = path.join(process.cwd(), 'data', 'history');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.jsonl`);
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  console.log(`exported ${rows.length} rows to ${file}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => pool.end());
