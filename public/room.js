const roomId = Number(queryParam('id'));
const MATCH_CHECK_KEYS = ['any', 'md', 'wd', 'xd', 'ms', 'ws', 'xs'];
let pageUser = null;
let roomPayload = null;
let socket = null;

(async () => {
  pageUser = await requireUser();
  if (!pageUser) return;
  if (!roomId) {
    window.location.href = '/rooms.html';
    return;
  }

  renderUserAction(pageUser);
  document.body.insertAdjacentHTML('beforeend', bottomNav('room', pageUser));
  bindRoomPage();
  connectRoomSocket();
  await loadRoom();
})();

function bindRoomPage() {
  $$('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.tabs button').forEach((item) => item.classList.remove('active'));
      $$('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      button.classList.add('active');
      $(`#${button.dataset.tab}`).classList.add('active');
    });
  });

  $('#stateForm').addEventListener('submit', saveState);
  $('#temporaryMemberForm').addEventListener('submit', createTemporaryMember);
  $('#freeMatchForm').addEventListener('submit', createFreeMatch);
  $('#roundMatchForm').addEventListener('submit', createRoundMatches);
  $('#leaveRoomBtn').addEventListener('click', leaveRoom);
  $('#dissolveRoomBtn').addEventListener('click', dissolveCurrentRoom);
  $('#refreshRoomBtn').addEventListener('click', loadRoom);
}

function connectRoomSocket() {
  if (typeof io === 'undefined') return;
  socket = io();
  socket.on('connect', () => socket.emit('room:join', roomId));
  socket.on('room:changed', (event) => {
    if (Number(event.roomId) === roomId) loadRoom();
  });
}

async function loadRoom() {
  try {
    roomPayload = await api(`/api/rooms/${roomId}`);
    renderRoom(roomPayload);
  } catch (error) {
    showMessage(error.message);
  }
}

function renderRoom(payload) {
  const { room, member, members, matches } = payload;
  $('#roomTitle').textContent = room.name;
  $('#roomMeta').textContent = `${room.code} · ${room.court_count} 场地 · ${room.mode === 'round' ? '固定场次' : '自由匹配'}`;
  const isOwner = Number(room.owner_user_id) === pageUser.id;
  const canManageMembers = isOwner || pageUser.role === 'admin';

  renderPreferenceChecks(member ? member.match_preferences || member.match_preference : 'any');
  renderStatus(member);
  renderFreeMatchChecks();
  renderCourtModes(room.court_count);
  renderMembers(members);
  renderMatches(matches);

  $$('[data-mode-panel]').forEach((panel) => {
    panel.classList.toggle('hide', panel.dataset.modePanel !== room.mode);
  });
  $('#leaveRoomBtn').classList.toggle('hide', isOwner);
  $('#dissolveRoomBtn').classList.toggle('hide', !isOwner && pageUser.role !== 'admin');
  $('#temporaryMemberForm').classList.toggle('hide', !canManageMembers);
}

function renderStatus(member) {
  if (!member) return;
  const radio = $(`#stateForm [name="playStatus"][value="${member.play_status}"]`);
  if (radio) radio.checked = true;
}

function renderPreferenceChecks(raw) {
  const selected = new Set(matchPreferenceValues(raw));
  renderCheckGroup($('#preferenceChecks'), {
    keys: MATCH_CHECK_KEYS,
    name: 'matchPreferences',
    prefix: 'pref',
    selected
  });
}

function renderFreeMatchChecks() {
  const current = selectedFreeMatchTypes(false);
  renderCheckGroup($('#freeMatchChecks'), {
    keys: MATCH_CHECK_KEYS,
    name: 'freeMatchTypes',
    prefix: 'free',
    selected: new Set(current.length ? current : ['any'])
  });
}

function renderCheckGroup(container, { keys, name, prefix, selected }) {
  container.innerHTML = keys.map((key) => `
    <input id="${prefix}-${key}" type="checkbox" name="${name}" value="${key}" ${selected.has(key) ? 'checked' : ''}>
    <label for="${prefix}-${key}">${MatchLabels[key]}</label>
  `).join('');

  bindAnyCheckGroup(name, `${prefix}-any`);
}

function bindAnyCheckGroup(name, anyId) {
  const any = $(`#${anyId}`);
  const others = $$(`[name="${name}"]`).filter((checkbox) => checkbox.value !== 'any');

  any.addEventListener('change', () => {
    if (any.checked) others.forEach((checkbox) => { checkbox.checked = false; });
  });
  others.forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) any.checked = false;
      if (!others.some((item) => item.checked)) any.checked = true;
    });
  });
}

function checkedValues(name) {
  return $$(`[name="${name}"]:checked`).map((input) => input.value);
}

function selectedPreferences() {
  const values = checkedValues('matchPreferences');
  return values.length ? values : ['any'];
}

function selectedFreeMatchTypes(withDefault = true) {
  const values = checkedValues('freeMatchTypes');
  return values.length || !withDefault ? values : ['any'];
}

function renderCourtModes(count) {
  const current = $$('#courtModes select').map((select) => select.value);
  $('#courtModes').innerHTML = Array.from({ length: Number(count) }, (_, index) => `
    <label>
      ${index + 1} 号场
      <select name="courtMode">
        ${['xd', 'md', 'wd', 'ms', 'ws', 'xs'].map((key) => `
          <option value="${key}" ${current[index] === key ? 'selected' : ''}>${MatchLabels[key]}</option>
        `).join('')}
      </select>
    </label>
  `).join('');
}

function renderMembers(members) {
  $('#memberCount').textContent = `${members.filter((member) => member.presence_status === 'online').length}/${members.length}`;
  $('#memberList').innerHTML = members.map((member) => `
    <article class="item">
      <div class="item-head">
        <div>
          <strong>${escapeHtml(member.display_name)}</strong>
          <p class="meta">${GenderLabels[member.gender] || member.gender} · 等级 ${member.skill_level} · ${member.rating} 分</p>
        </div>
        <div class="row wrap">
          ${member.account_type === 'temporary' ? '<span class="pill resting">临时</span>' : ''}
          <span class="pill ${member.play_status}">${StatusLabels[member.play_status] || member.play_status}</span>
        </div>
      </div>
      ${member.account_type === 'temporary' ? `<p class="meta">用户名：${escapeHtml(member.username)} · 默认密码 000000</p>` : ''}
      <p class="meta">偏好：${formatMatchPreferences(member.match_preferences || member.match_preference)}</p>
      <p class="meta">${member.presence_status === 'online' ? '在线' : '离线'}${member.is_blacklisted ? ' · 已拉黑' : ''}</p>
      ${pageUser.role === 'admin' ? `
        <label>
          管理状态
          <select data-member-status="${member.user_id}">
            ${['idle', 'waiting', 'resting', 'busy', 'locked'].map((status) => `
              <option value="${status}" ${status === member.play_status ? 'selected' : ''}>${StatusLabels[status]}</option>
            `).join('')}
          </select>
        </label>
      ` : ''}
    </article>
  `).join('');

  $$('[data-member-status]').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        await api(`/api/admin/rooms/${roomId}/members/${select.dataset.memberStatus}`, {
          method: 'PATCH',
          body: { playStatus: select.value }
        });
        await loadRoom();
      } catch (error) {
        showMessage(error.message);
      }
    });
  });
}

async function createTemporaryMember(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const data = await api(`/api/rooms/${roomId}/temporary-members`, {
      method: 'POST',
      body: formObject(form)
    });
    form.reset();
    form.skillLevel.value = 5;
    form.rating.value = 1000;
    showMessage(`已添加 ${data.user.display_name}，用户名 ${data.user.username}，默认密码 ${data.defaultPassword}`);
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

function renderMatches(matches) {
  $('#matchList').innerHTML = matches.length
    ? matches.map(renderMatchCard).join('')
    : '<p class="muted">暂无比赛。</p>';

  $$('[data-finish-match]').forEach((button) => {
    button.addEventListener('click', () => finishMatch(button.dataset.finishMatch));
  });
  $$('[data-leave-match]').forEach((button) => {
    button.addEventListener('click', () => leaveMatch(button.dataset.leaveMatch));
  });
  $$('.result-form').forEach((form) => {
    form.addEventListener('submit', submitResult);
  });
}

function renderMatchCard(match) {
  const red = match.players.filter((player) => player.team === 'red');
  const blue = match.players.filter((player) => player.team === 'blue');
  const me = match.players.find((player) => Number(player.user_id) === pageUser.id);
  const room = roomPayload && roomPayload.room;
  const isOwner = room && Number(room.owner_user_id) === pageUser.id;
  const allTemporary = match.players.length > 0 && match.players.every((player) => player.account_type === 'temporary');
  const canJudgeAllTemporary = allTemporary && (isOwner || pageUser.role === 'admin');
  const isRealPlayer = me && me.account_type !== 'temporary';
  const canAct = (isRealPlayer || canJudgeAllTemporary) && ['active', 'awaiting_result'].includes(match.status);
  const needsResult = match.status === 'awaiting_result'
    && ((isRealPlayer && !me.result_submitted) || canJudgeAllTemporary);
  const submitted = isRealPlayer && match.status === 'awaiting_result' && me.result_submitted;
  const resultText = match.status === 'invalid'
    ? `无效：${escapeHtml(match.invalid_reason || '结果冲突')}`
    : match.result_winner
      ? winnerLabel(match.result_winner)
      : StatusLabels[match.status] || match.status;

  return `
    <article class="item">
      <div class="item-head">
        <div>
          <strong>${escapeHtml(match.label || MatchLabels[match.match_type])}${match.court_no ? ` · ${match.court_no} 号场` : ''}</strong>
          <p class="meta">第 ${match.round_no || 1} 轮</p>
        </div>
        <span class="pill ${match.status}">${resultText}</span>
      </div>
      <div class="team-board">
        <div class="team red">
          <strong>红方</strong>
          ${red.map(playerLine).join('')}
        </div>
        <div class="team blue">
          <strong>蓝方</strong>
          ${blue.map(playerLine).join('')}
        </div>
      </div>
      ${canAct ? `
        <div class="row wrap">
          ${match.status === 'active' ? `
            <button type="button" data-finish-match="${match.id}">结束</button>
            ${isRealPlayer ? `<button type="button" class="danger" data-leave-match="${match.id}">退出</button>` : ''}
          ` : ''}
          ${needsResult ? resultForm(match.id, { authority: canJudgeAllTemporary && !isRealPlayer }) : ''}
          ${submitted ? '<span class="meta">已提交，等待其他成员</span>' : ''}
        </div>
      ` : ''}
    </article>
  `;
}

function playerLine(player) {
  return `<span>${escapeHtml(player.display_name)} <small>${player.rating_before}${player.account_type === 'temporary' ? ' · 临时' : ''}${player.result_submitted ? ' · 已交' : ''}</small></span>`;
}

function resultForm(matchId, options = {}) {
  const resultSelect = options.authority
    ? `<select name="verdict">
        <option value="">按比分</option>
        <option value="red">红方胜</option>
        <option value="blue">蓝方胜</option>
        <option value="draw">平</option>
        <option value="terminated">终止</option>
      </select>`
    : `<select name="outcome">
        <option value="">按比分</option>
        <option value="win">赢</option>
        <option value="lose">输</option>
        <option value="draw">平</option>
        <option value="terminated">终止</option>
      </select>`;

  return `
    <form class="result-form" data-result-match="${matchId}">
      ${resultSelect}
      <input name="scoreRed" type="number" min="0" placeholder="红">
      <input name="scoreBlue" type="number" min="0" placeholder="蓝">
      <button type="submit">提交结果</button>
    </form>
  `;
}

function winnerLabel(winner) {
  return {
    red: '红方胜',
    blue: '蓝方胜',
    draw: '平',
    terminated: '终止',
    invalid: '无效'
  }[winner] || winner;
}

async function saveState(event) {
  event.preventDefault();
  const data = formObject(event.currentTarget);
  try {
    await api(`/api/rooms/${roomId}/my-state`, {
      method: 'PATCH',
      body: {
        playStatus: data.playStatus,
        matchPreferences: selectedPreferences()
      }
    });
    showMessage('状态已保存');
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function createFreeMatch(event) {
  event.preventDefault();
  try {
    const data = await api(`/api/rooms/${roomId}/match/free`, {
      method: 'POST',
      body: { matchTypes: selectedFreeMatchTypes() }
    });
    showMessage(`已创建 ${MatchLabels[data.match.matchType] || '比赛'} 匹配`);
    await loadRoom();
    $('[data-tab="matchesPanel"]').click();
  } catch (error) {
    showMessage(error.message);
  }
}

async function createRoundMatches(event) {
  event.preventDefault();
  try {
    const courtModes = $$('#courtModes select').map((select) => select.value);
    const data = await api(`/api/rooms/${roomId}/match/round`, {
      method: 'POST',
      body: { courtModes }
    });
    if (data.skipped && data.skipped.length) {
      showMessage(`成功 ${data.matches.length} 场，${data.skipped.length} 个场地未匹配`);
    }
    await loadRoom();
    $('[data-tab="matchesPanel"]').click();
  } catch (error) {
    showMessage(error.message);
  }
}

async function finishMatch(matchId) {
  try {
    await api(`/api/rooms/matches/${matchId}/finish`, { method: 'POST' });
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function leaveMatch(matchId) {
  try {
    await api(`/api/rooms/matches/${matchId}/leave`, { method: 'POST' });
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function submitResult(event) {
  event.preventDefault();
  const matchId = event.currentTarget.dataset.resultMatch;
  const data = formObject(event.currentTarget);
  try {
    const result = await api(`/api/rooms/matches/${matchId}/results`, {
      method: 'POST',
      body: {
        outcome: data.outcome || null,
        verdict: data.verdict || null,
        scoreRed: data.scoreRed,
        scoreBlue: data.scoreBlue
      }
    });
    showMessage(result.finalized ? '比赛已结算' : `已提交，等待 ${result.needed - result.submitted} 人`);
    await loadRoom();
  } catch (error) {
    showMessage(error.message);
  }
}

async function leaveRoom() {
  try {
    await api(`/api/rooms/${roomId}/leave`, { method: 'POST' });
    if (socket) socket.emit('room:leave', roomId);
    window.location.href = '/rooms.html';
  } catch (error) {
    showMessage(error.message);
  }
}

async function dissolveCurrentRoom() {
  if (!window.confirm('确认解散这个房间？房间会从普通列表消失，比赛履历会保留。')) return;
  try {
    await api(`/api/rooms/${roomId}`, { method: 'DELETE' });
    if (socket) socket.emit('room:leave', roomId);
    window.location.href = '/rooms.html';
  } catch (error) {
    showMessage(error.message);
  }
}
