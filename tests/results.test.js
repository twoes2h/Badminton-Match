const assert = require('assert');
const { pool } = require('../src/db');
const { resolveWinner, resolveTimedOutWinner, calculateRatingDeltas } = require('../src/services/results');

function player(userId, team, rating = 1000, accountType = 'normal') {
  return {
    user_id: userId,
    team,
    rating_before: rating,
    account_type: accountType
  };
}

function result(userId, fields) {
  return {
    user_id: userId,
    outcome: null,
    score_red: null,
    score_blue: null,
    ...fields
  };
}

{
  const players = [player(1, 'red'), player(2, 'blue')];
  const resolved = resolveWinner(players, [
    result(1, { score_red: 21, score_blue: 17 }),
    result(2, { outcome: 'win' })
  ]);
  assert.strictEqual(resolved.winner, 'red');
  assert.strictEqual(resolved.status, 'completed');
}

{
  const players = [player(1, 'red'), player(2, 'blue')];
  const resolved = resolveWinner(players, [
    result(1, { score_red: 21, score_blue: 17 }),
    result(2, { score_red: 16, score_blue: 21 })
  ]);
  assert.strictEqual(resolved.winner, 'invalid');
}

{
  const players = [
    player(1, 'red'),
    player(2, 'red'),
    player(3, 'blue'),
    player(4, 'blue')
  ];
  const resolved = resolveWinner(players, [
    result(1, { outcome: 'win' }),
    result(2, { outcome: 'win' }),
    result(3, { outcome: 'lose' }),
    result(4, { outcome: 'win' })
  ]);
  assert.strictEqual(resolved.winner, 'red');
}

{
  const players = [
    player(1, 'red'),
    player(2, 'red'),
    player(3, 'blue'),
    player(4, 'blue')
  ];
  const resolved = resolveWinner(players, [
    result(1, { outcome: 'win' }),
    result(2, { outcome: 'win' }),
    result(3, { outcome: 'win' }),
    result(4, { outcome: 'win' })
  ]);
  assert.strictEqual(resolved.winner, 'invalid');
}

{
  const players = [player(1, 'red', 1000), player(2, 'blue', 1000)];
  const resolved = resolveWinner(players, [
    result(1, { score_red: 21, score_blue: 17 }),
    result(2, { score_red: 21, score_blue: 15 })
  ]);
  assert.strictEqual(resolved.winner, 'red');
  assert.strictEqual(resolved.averageDiff, 5);
  const deltas = calculateRatingDeltas(players, resolved);
  assert.strictEqual(deltas[0].delta, -deltas[1].delta);
  assert.ok(deltas[0].delta > 0);
}

{
  const players = [
    player(1, 'red'),
    player(2, 'red', 1000, 'temporary'),
    player(3, 'blue'),
    player(4, 'blue')
  ];
  const resolved = resolveWinner(players, [
    result(1, { outcome: 'win' }),
    result(3, { outcome: 'lose' }),
    result(4, { outcome: 'win' })
  ]);
  assert.strictEqual(resolved.winner, 'red');
}

{
  const players = [
    player(1, 'red', 1000, 'temporary'),
    player(2, 'red', 1000, 'temporary'),
    player(3, 'blue', 1000, 'temporary'),
    player(4, 'blue')
  ];
  const resolved = resolveWinner(players, [
    result(4, { outcome: 'win' })
  ]);
  assert.strictEqual(resolved.winner, 'blue');
}

{
  const players = [
    player(1, 'red', 1000, 'temporary'),
    player(2, 'red', 1000, 'temporary'),
    player(3, 'blue', 1000, 'temporary'),
    player(4, 'blue', 1000, 'temporary')
  ];
  const resolved = resolveWinner(players, [
    result(99, { verdict: 'red' })
  ]);
  assert.strictEqual(resolved.winner, 'red');
}

{
  const players = [
    player(1, 'red'),
    player(2, 'red'),
    player(3, 'blue'),
    player(4, 'blue')
  ];
  const resolved = resolveTimedOutWinner(players, [
    result(1, { outcome: 'win' })
  ]);
  assert.strictEqual(resolved.winner, 'red');
}

{
  const players = [
    player(1, 'red'),
    player(2, 'red'),
    player(3, 'blue'),
    player(4, 'blue')
  ];
  const resolved = resolveTimedOutWinner(players, []);
  assert.strictEqual(resolved.winner, 'draw');
}

{
  const players = [
    player(1, 'red', 1000, 'temporary'),
    player(2, 'red', 1000, 'temporary'),
    player(3, 'blue', 1000, 'temporary'),
    player(4, 'blue', 1000, 'temporary')
  ];
  const resolved = resolveTimedOutWinner(players, []);
  assert.strictEqual(resolved.winner, 'draw');
}

pool.end()
  .then(() => {
    console.log('results tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
