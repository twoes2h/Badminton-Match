const { transaction } = require('../db');

function oppositeTeam(team) {
  return team === 'red' ? 'blue' : 'red';
}

function normalizeSubmission(result, playerTeam) {
  const hasScore = result.score_red !== null && result.score_red !== undefined
    && result.score_blue !== null && result.score_blue !== undefined;

  if (hasScore) {
    const scoreRed = Number(result.score_red);
    const scoreBlue = Number(result.score_blue);
    if (!Number.isInteger(scoreRed) || !Number.isInteger(scoreBlue) || scoreRed < 0 || scoreBlue < 0) {
      throw new Error('比分必须是非负整数');
    }
    return {
      source: 'score',
      verdict: scoreRed > scoreBlue ? 'red' : scoreRed < scoreBlue ? 'blue' : 'draw',
      diff: Math.abs(scoreRed - scoreBlue),
      scoreRed,
      scoreBlue
    };
  }

  if (!result.outcome) {
    throw new Error('请选择输赢平终止，或输入比分');
  }

  const map = {
    win: playerTeam,
    lose: oppositeTeam(playerTeam),
    draw: 'draw',
    terminated: 'terminated'
  };

  if (!map[result.outcome]) {
    throw new Error('不支持的结果选项');
  }

  return {
    source: 'outcome',
    verdict: map[result.outcome],
    diff: null,
    scoreRed: null,
    scoreBlue: null
  };
}

function countByVerdict(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.verdict, Number(counts.get(item.verdict) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([verdict, count]) => ({ verdict, count }))
    .sort((a, b) => b.count - a.count);
}

function resolveWinner(players, results) {
  const byUser = new Map(players.map((player) => [Number(player.user_id), player]));
  const normalized = results.map((result) => {
    const player = byUser.get(Number(result.user_id));
    return {
      ...normalizeSubmission(result, player.team),
      userId: Number(result.user_id),
      team: player.team
    };
  });

  const scoreBased = normalized.filter((item) => item.source === 'score');
  const decidingItems = scoreBased.length > 0 ? scoreBased : normalized;
  const counts = countByVerdict(decidingItems);
  const top = counts[0];
  const second = counts[1];

  if (!top || (second && top.count === second.count)) {
    return {
      status: 'invalid',
      winner: 'invalid',
      invalidReason: '结果提交存在逻辑冲突',
      averageDiff: null,
      scoreRed: null,
      scoreBlue: null
    };
  }

  if (scoreBased.length === 0 && top.count <= players.length / 2) {
    return {
      status: 'invalid',
      winner: 'invalid',
      invalidReason: '未形成多数一致结果',
      averageDiff: null,
      scoreRed: null,
      scoreBlue: null
    };
  }

  const winner = top.verdict;
  const winnerScoreItems = scoreBased.filter((item) => item.verdict === winner);
  const averageDiff = winnerScoreItems.length
    ? Math.round(
      winnerScoreItems.reduce((sum, item) => sum + item.diff, 0) / winnerScoreItems.length
    )
    : null;
  const scoreRed = winnerScoreItems.length
    ? Math.round(
      winnerScoreItems.reduce((sum, item) => sum + item.scoreRed, 0) / winnerScoreItems.length
    )
    : null;
  const scoreBlue = winnerScoreItems.length
    ? Math.round(
      winnerScoreItems.reduce((sum, item) => sum + item.scoreBlue, 0) / winnerScoreItems.length
    )
    : null;

  return {
    status: winner === 'terminated' ? 'completed' : 'completed',
    winner,
    invalidReason: null,
    averageDiff,
    scoreRed,
    scoreBlue
  };
}

function calculateRatingDeltas(players, resolution) {
  if (resolution.winner === 'invalid' || resolution.winner === 'terminated') {
    return players.map((player) => ({
      userId: Number(player.user_id),
      before: Number(player.rating_before),
      after: Number(player.rating_before),
      delta: 0
    }));
  }

  const red = players.filter((player) => player.team === 'red');
  const blue = players.filter((player) => player.team === 'blue');
  const redAvg = avg(red.map((player) => Number(player.rating_before)));
  const blueAvg = avg(blue.map((player) => Number(player.rating_before)));
  const expectedRed = 1 / (1 + Math.pow(10, (blueAvg - redAvg) / 400));
  const actualRed = resolution.winner === 'red' ? 1 : resolution.winner === 'blue' ? 0 : 0.5;
  const marginFactor = resolution.averageDiff ? Math.min(1.75, 1 + resolution.averageDiff / 42) : 1;
  const deltaRed = Math.round(24 * marginFactor * (actualRed - expectedRed));

  return players.map((player) => {
    const before = Number(player.rating_before);
    const delta = player.team === 'red' ? deltaRed : -deltaRed;
    return {
      userId: Number(player.user_id),
      before,
      after: before + delta,
      delta
    };
  });
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function markMatchAwaitingResult(conn, matchId) {
  const matches = await conn.query('SELECT * FROM matches WHERE id = ? LIMIT 1', [matchId]);
  const match = matches[0];
  if (!match) throw new Error('比赛不存在');

  if (match.status === 'completed' || match.status === 'invalid' || match.status === 'cancelled') {
    return match;
  }

  await conn.query(
    `UPDATE matches
     SET status = 'awaiting_result',
         ended_at = COALESCE(ended_at, NOW())
     WHERE id = ?`,
    [matchId]
  );
  await conn.query(
    `UPDATE room_members rm
     JOIN match_players mp ON mp.user_id = rm.user_id
     SET rm.play_status = 'awaiting_result'
     WHERE mp.match_id = ?
       AND rm.room_id = ?`,
    [matchId, match.room_id]
  );
  return { ...match, status: 'awaiting_result' };
}

async function submitMatchResult({ matchId, userId, outcome, scoreRed, scoreBlue, note }) {
  return transaction(async (conn) => {
    const playerRows = await conn.query(
      `SELECT mp.*, m.room_id, m.status
       FROM match_players mp
       JOIN matches m ON m.id = mp.match_id
       WHERE mp.match_id = ?
         AND mp.user_id = ?
       LIMIT 1`,
      [matchId, userId]
    );
    const player = playerRows[0];
    if (!player) throw new Error('你不属于这场比赛');
    if (player.status === 'completed' || player.status === 'invalid' || player.status === 'cancelled') {
      throw new Error('这场比赛已经结算');
    }

    await markMatchAwaitingResult(conn, matchId);
    const normalized = {
      outcome: outcome || null,
      score_red: scoreRed === '' || scoreRed === undefined ? null : scoreRed,
      score_blue: scoreBlue === '' || scoreBlue === undefined ? null : scoreBlue
    };
    normalizeSubmission(normalized, player.team);

    await conn.query(
      `INSERT INTO match_results (match_id, user_id, outcome, score_red, score_blue, note)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         outcome = VALUES(outcome),
         score_red = VALUES(score_red),
         score_blue = VALUES(score_blue),
         note = VALUES(note),
         submitted_at = NOW()`,
      [matchId, userId, normalized.outcome, normalized.score_red, normalized.score_blue, note || null]
    );
    await conn.query(
      'UPDATE match_players SET result_submitted = 1 WHERE match_id = ? AND user_id = ?',
      [matchId, userId]
    );

    return finalizeIfReady(conn, matchId);
  });
}

async function finalizeIfReady(conn, matchId) {
  const players = await conn.query(
    `SELECT mp.*, u.display_name
     FROM match_players mp
     JOIN users u ON u.id = mp.user_id
     WHERE mp.match_id = ?
     ORDER BY mp.team, mp.id`,
    [matchId]
  );
  const results = await conn.query('SELECT * FROM match_results WHERE match_id = ?', [matchId]);
  if (results.length < players.length) {
    return {
      finalized: false,
      needed: players.length,
      submitted: results.length
    };
  }

  const matchRows = await conn.query('SELECT * FROM matches WHERE id = ? LIMIT 1', [matchId]);
  const match = matchRows[0];
  if (!match) throw new Error('比赛不存在');

  const resolution = resolveWinner(players, results);
  const deltas = calculateRatingDeltas(players, resolution);
  const finalStatus = resolution.winner === 'invalid' ? 'invalid' : 'completed';

  await conn.query(
    `UPDATE matches
     SET status = ?,
         result_winner = ?,
         score_red = ?,
         score_blue = ?,
         rating_delta_json = ?,
         invalid_reason = ?,
         finalized_at = NOW(),
         ended_at = COALESCE(ended_at, NOW())
     WHERE id = ?`,
    [
      finalStatus,
      resolution.winner,
      resolution.scoreRed,
      resolution.scoreBlue,
      JSON.stringify(deltas),
      resolution.invalidReason,
      matchId
    ]
  );

  for (const delta of deltas) {
    await conn.query(
      'UPDATE match_players SET rating_after = ? WHERE match_id = ? AND user_id = ?',
      [delta.after, matchId, delta.userId]
    );
    await conn.query(
      'UPDATE users SET rating = ?, matches_played = matches_played + 1 WHERE id = ?',
      [delta.after, delta.userId]
    );
    if (delta.delta !== 0) {
      await conn.query(
        `INSERT INTO rating_events
          (match_id, user_id, rating_before, rating_after, delta_value, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [matchId, delta.userId, delta.before, delta.after, delta.delta, 'match_result']
      );
    }
  }

  await conn.query(
    `UPDATE room_members rm
     JOIN match_players mp ON mp.user_id = rm.user_id
     SET rm.play_status = 'idle',
         rm.current_match_id = NULL
     WHERE mp.match_id = ?
       AND rm.room_id = ?`,
    [matchId, match.room_id]
  );

  return {
    finalized: true,
    status: finalStatus,
    winner: resolution.winner,
    invalidReason: resolution.invalidReason,
    deltas
  };
}

module.exports = {
  markMatchAwaitingResult,
  submitMatchResult,
  finalizeIfReady,
  resolveWinner,
  calculateRatingDeltas
};
