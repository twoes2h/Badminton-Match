const assert = require('assert');
const { resolveWinner, calculateRatingDeltas } = require('../src/services/results');

function player(userId, team, rating = 1000) {
  return {
    user_id: userId,
    team,
    rating_before: rating
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

console.log('results tests passed');
