const MATCH_LABELS = {
  any: '不限',
  md: '男双',
  wd: '女双',
  xd: '混双',
  ms: '男单',
  ws: '女单',
  xs: '男女单打'
};

const STATUS_LABELS = {
  idle: '空闲',
  waiting: '等待匹配',
  resting: '休息',
  busy: '忙碌',
  in_match: '比赛中',
  awaiting_result: '待成绩',
  locked: '锁定',
  online: '在线',
  offline: '离线',
  active: '进行中',
  completed: '已完成',
  invalid: '无效',
  awaiting_result_match: '待成绩',
  cancelled: '已取消'
};

const GENDER_LABELS = {
  male: '男',
  female: '女',
  other: '其他'
};

const state = {
  user: null,
  currentRoomId: null,
  roomPayload: null,
  socket: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options,
    body: options.body && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || '请求失败');
  }
  return data;
}

function message(text) {
  const box = $('#message');
  if (!text) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.textContent = text;
  box.classList.remove('hidden');
  window.clearTimeout(message.timer);
  message.timer = window.setTimeout(() => message(''), 4200);
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setUser(user) {
  state.user = user;
  $('#authView').classList.toggle('hidden', Boolean(user));
  $('#mainView').classList.toggle('hidden', !user);
  $('#adminPanel').classList.toggle('hidden', !user || user.role !== 'admin');
  $('#userBox').innerHTML = user
    ? `<span>${escapeHtml(user.displayName || user.username)}</span><button type="button" id="logoutBtn" class="secondary">退出登录</button>`
    : '';
  if (user) {
    $('#logoutBtn').addEventListener('click', logout);
    connectSocket();
    loadRooms();
    if (user.role === 'admin') loadAdminData();
  }
}

function connectSocket() {
  if (state.socket || typeof io === 'undefined') return;
  state.socket = io();
  state.socket.on('room:changed', (event) => {
    if (Number(event.roomId) === Number(state.currentRoomId)) {
      loadRoom(state.currentRoomId);
    }
    loadRooms();
  });
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.currentRoomId = null;
    state.roomPayload = null;
    if (state.socket) state.socket.disconnect();
    state.socket = null;
    renderEmptyRoom();
    setUser(null);
  } catch (error) {
    message(error.message);
  }
}

async function loadMe() {
  try {
    const data = await api('/api/auth/me');
    setUser({
      id: data.user.id,
      username: data.user.username,
      displayName: data.user.display_name,
      role: data.user.role
    });
  } catch {
    setUser(null);
  }
}

async function loadRooms(q = '') {
  if (!state.user) return;
  try {
    const data = await api(`/api/rooms${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    $('#roomList').innerHTML = data.rooms.map((room) => `
      <article class="room-item">
        <strong>${escapeHtml(room.name)} · ${escapeHtml(room.code)}</strong>
        <span>${room.online_count || 0}/${room.max_people} 在线 · ${room.court_count} 场地 · ${room.mode === 'round' ? '固定场次' : '自由匹配'}</span>
        <button type="button" data-join-room="${room.id}">进入</button>
      </article>
    `).join('') || '<p class="muted">暂无房间</p>';
    $$('[data-join-room]').forEach((button) => {
      button.addEventListener('click', () => joinRoom(button.dataset.joinRoom));
    });
  } catch (error) {
    message(error.message);
  }
}

async function joinRoom(roomId) {
  const password = window.prompt('房间密码，没有则留空') || '';
  try {
    await api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: { password }
    });
    state.currentRoomId = Number(roomId);
    if (state.socket) state.socket.emit('room:join', state.currentRoomId);
    await loadRoom(state.currentRoomId);
  } catch (error) {
    message(error.message);
  }
}

async function loadRoom(roomId) {
  try {
    const payload = await api(`/api/rooms/${roomId}`);
    state.currentRoomId = Number(roomId);
    state.roomPayload = payload;
    renderRoom(payload);
  } catch (error) {
    message(error.message);
  }
}

function renderEmptyRoom() {
  $('#roomView').classList.add('hidden');
  $('#emptyRoom').classList.remove('hidden');
}

function renderRoom(payload) {
  $('#emptyRoom').classList.add('hidden');
  $('#roomView').classList.remove('hidden');

  const { room, member, members, matches } = payload;
  $('#roomCode').textContent = `${room.code} · ${room.sport_key}`;
  $('#roomName').textContent = room.name;
  $('#roomAdminPanel').classList.toggle('hidden', state.user.role !== 'admin');
  $('#roomAdminForm [name="courtCount"]').value = room.court_count;
  $('#roomAdminForm [name="maxPeople"]').value = room.max_people;

  fillMatchSelect($('#matchPreference'), true);
  fillMatchSelect($('#freeMatchType'), false);
  if (member) {
    const statusRadio = $(`#stateForm [value="${member.play_status}"]`);
    if (statusRadio) statusRadio.checked = true;
    $('#matchPreference').value = member.match_preference || 'any';
  }

  renderCourtModeSelects(room.court_count);
  renderMembers(members);
  renderMatches(matches);
}

function fillMatchSelect(select, includeAny) {
  const current = select.value;
  const keys = includeAny ? ['any', 'md', 'wd', 'xd', 'ms', 'ws', 'xs'] : ['md', 'wd', 'xd', 'ms', 'ws', 'xs'];
  select.innerHTML = keys.map((key) => `<option value="${key}">${MATCH_LABELS[key]}</option>`).join('');
  if (keys.includes(current)) select.value = current;
}

function renderCourtModeSelects(courtCount) {
  const wrap = $('#courtModes');
  const current = $$('#courtModes select').map((select) => select.value);
  wrap.innerHTML = Array.from({ length: Number(courtCount) }, (_, index) => `
    <label>
      ${index + 1} 号场
      <select name="courtMode">
        ${['xd', 'md', 'wd', 'ms', 'ws', 'xs'].map((key) => `
          <option value="${key}" ${current[index] === key ? 'selected' : ''}>${MATCH_LABELS[key]}</option>
        `).join('')}
      </select>
    </label>
  `).join('');
}

function renderMembers(members) {
  const isAdmin = state.user.role === 'admin';
  $('.admin-only').classList.toggle('hidden', !isAdmin);
  $('#memberRows').innerHTML = members.map((member) => `
    <tr>
      <td>
        <strong>${escapeHtml(member.display_name)}</strong>
        <div class="subtle">${member.presence_status === 'online' ? '在线' : '离线'}${member.is_blacklisted ? ' · 黑名单' : ''}</div>
      </td>
      <td>${GENDER_LABELS[member.gender] || member.gender}</td>
      <td><span class="status-pill status-${member.play_status}">${STATUS_LABELS[member.play_status] || member.play_status}</span></td>
      <td>${MATCH_LABELS[member.match_preference] || member.match_preference}</td>
      <td>${member.skill_level}</td>
      <td>${member.rating}</td>
      <td class="${isAdmin ? '' : 'hidden'}">
        <select class="admin-select" data-member-status="${member.user_id}">
          ${['idle', 'waiting', 'resting', 'busy', 'locked'].map((status) => `
            <option value="${status}" ${status === member.play_status ? 'selected' : ''}>${STATUS_LABELS[status]}</option>
          `).join('')}
        </select>
      </td>
    </tr>
  `).join('');

  $$('[data-member-status]').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        await api(`/api/admin/rooms/${state.currentRoomId}/members/${select.dataset.memberStatus}`, {
          method: 'PATCH',
          body: { playStatus: select.value }
        });
        await loadRoom(state.currentRoomId);
      } catch (error) {
        message(error.message);
      }
    });
  });
}

function renderMatches(matches) {
  if (!matches.length) {
    $('#matchList').innerHTML = '<p class="muted">暂无比赛</p>';
    return;
  }

  $('#matchList').innerHTML = matches.map((match) => {
    const red = match.players.filter((player) => player.team === 'red');
    const blue = match.players.filter((player) => player.team === 'blue');
    const me = match.players.find((player) => Number(player.user_id) === Number(state.user.id));
    const canAct = me && ['active', 'awaiting_result'].includes(match.status);
    const needsResult = canAct && match.status === 'awaiting_result' && !me.result_submitted;
    const submitted = canAct && match.status === 'awaiting_result' && me.result_submitted;
    const resultText = match.status === 'invalid'
      ? `无效 · ${escapeHtml(match.invalid_reason || '结果冲突')}`
      : match.result_winner
        ? `${winnerLabel(match.result_winner)}${match.score_red !== null ? ` · 红 ${match.score_red} 蓝 ${match.score_blue}` : ''}`
        : STATUS_LABELS[match.status === 'awaiting_result' ? 'awaiting_result_match' : match.status];

    return `
      <article class="match-card">
        <div class="match-head">
          <strong>${escapeHtml(match.label || MATCH_LABELS[match.match_type])}${match.court_no ? ` · ${match.court_no} 号场` : ''}</strong>
          <span class="status-pill">${resultText}</span>
        </div>
        <div class="match-court">
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
          <div class="match-actions">
            ${match.status === 'active' ? `
              <button type="button" data-finish-match="${match.id}">结束比赛</button>
              <button type="button" class="danger" data-leave-match="${match.id}">退出比赛</button>
            ` : ''}
            ${needsResult ? resultFormHtml(match.id) : ''}
            ${submitted ? '<span class="subtle">已提交，等待其他成员</span>' : ''}
          </div>
        ` : ''}
      </article>
    `;
  }).join('');

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

function playerLine(player) {
  const submitted = player.result_submitted ? ' · 已交' : '';
  return `<span>${escapeHtml(player.display_name)} <small>${player.rating_before}${submitted}</small></span>`;
}

function resultFormHtml(matchId) {
  const template = $('#resultFormTemplate').innerHTML;
  return template.replace('<form class="result-form">', `<form class="result-form" data-result-match="${matchId}">`);
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

async function finishMatch(matchId) {
  try {
    await api(`/api/rooms/matches/${matchId}/finish`, { method: 'POST' });
    await loadRoom(state.currentRoomId);
  } catch (error) {
    message(error.message);
  }
}

async function leaveMatch(matchId) {
  try {
    await api(`/api/rooms/matches/${matchId}/leave`, { method: 'POST' });
    await loadRoom(state.currentRoomId);
  } catch (error) {
    message(error.message);
  }
}

async function submitResult(event) {
  event.preventDefault();
  const data = formData(event.currentTarget);
  const matchId = event.currentTarget.dataset.resultMatch;
  try {
    const result = await api(`/api/rooms/matches/${matchId}/results`, {
      method: 'POST',
      body: {
        outcome: data.outcome || null,
        scoreRed: data.scoreRed,
        scoreBlue: data.scoreBlue
      }
    });
    message(result.finalized ? '比赛已结算' : `已提交，等待 ${result.needed - result.submitted} 人`);
    await loadRoom(state.currentRoomId);
  } catch (error) {
    message(error.message);
  }
}

async function loadAdminData() {
  if (!state.user || state.user.role !== 'admin') return;
  try {
    const [roomData, userData] = await Promise.all([
      api('/api/admin/rooms'),
      api('/api/admin/users')
    ]);
    $('#adminRooms').innerHTML = '<h3>房间</h3>' + roomData.rooms.slice(0, 8).map((room) => `
      <article class="mini-item">
        <strong>${escapeHtml(room.name)} · ${escapeHtml(room.code)}</strong>
        <span>${room.status} · ${room.online_count || 0}/${room.max_people}</span>
        <button type="button" class="danger" data-admin-dissolve="${room.id}">解散</button>
      </article>
    `).join('');
    $('#adminUsers').innerHTML = '<h3>用户</h3>' + userData.users.slice(0, 12).map((user) => `
      <article class="mini-item">
        <strong>${escapeHtml(user.display_name)} · ${escapeHtml(user.username)}</strong>
        <span>${user.role} · ${user.rating} 分 · ${user.is_blacklisted ? '已拉黑' : '正常'}</span>
        <button type="button" data-admin-blacklist="${user.id}" data-value="${user.is_blacklisted ? '0' : '1'}">
          ${user.is_blacklisted ? '解除拉黑' : '拉黑'}
        </button>
      </article>
    `).join('');

    $$('[data-admin-dissolve]').forEach((button) => {
      button.addEventListener('click', () => dissolveRoom(button.dataset.adminDissolve));
    });
    $$('[data-admin-blacklist]').forEach((button) => {
      button.addEventListener('click', () => setBlacklist(button.dataset.adminBlacklist, button.dataset.value === '1'));
    });
  } catch (error) {
    message(error.message);
  }
}

async function dissolveRoom(roomId) {
  if (!window.confirm('确认解散房间？')) return;
  try {
    await api(`/api/admin/rooms/${roomId}`, { method: 'DELETE' });
    if (Number(state.currentRoomId) === Number(roomId)) renderEmptyRoom();
    await loadRooms();
    await loadAdminData();
  } catch (error) {
    message(error.message);
  }
}

async function setBlacklist(userId, isBlacklisted) {
  try {
    await api(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: { isBlacklisted }
    });
    await loadAdminData();
    if (state.currentRoomId) await loadRoom(state.currentRoomId);
  } catch (error) {
    message(error.message);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function bindForms() {
  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: formData(event.currentTarget)
      });
      setUser(data.user);
    } catch (error) {
      message(error.message);
    }
  });

  $('#registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: formData(event.currentTarget)
      });
      setUser(data.user);
    } catch (error) {
      message(error.message);
    }
  });

  $('#createRoomForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = formData(event.currentTarget);
      const created = await api('/api/rooms', {
        method: 'POST',
        body: data
      });
      state.currentRoomId = Number(created.room.id);
      if (state.socket) state.socket.emit('room:join', state.currentRoomId);
      await loadRooms();
      await loadRoom(state.currentRoomId);
    } catch (error) {
      message(error.message);
    }
  });

  $('#searchRoomForm').addEventListener('submit', (event) => {
    event.preventDefault();
    loadRooms(formData(event.currentTarget).q || '');
  });

  $('#stateForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    try {
      await api(`/api/rooms/${state.currentRoomId}/my-state`, {
        method: 'PATCH',
        body: data
      });
      await loadRoom(state.currentRoomId);
    } catch (error) {
      message(error.message);
    }
  });

  $('#freeMatchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/rooms/${state.currentRoomId}/match/free`, {
        method: 'POST',
        body: formData(event.currentTarget)
      });
      await loadRoom(state.currentRoomId);
    } catch (error) {
      message(error.message);
    }
  });

  $('#roundMatchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const courtModes = $$('#courtModes select').map((select) => select.value);
      const data = await api(`/api/rooms/${state.currentRoomId}/match/round`, {
        method: 'POST',
        body: { courtModes }
      });
      if (data.skipped && data.skipped.length) {
        message(`本轮完成 ${data.matches.length} 场，${data.skipped.length} 个场地未匹配`);
      }
      await loadRoom(state.currentRoomId);
    } catch (error) {
      message(error.message);
    }
  });

  $('#leaveRoomBtn').addEventListener('click', async () => {
    try {
      await api(`/api/rooms/${state.currentRoomId}/leave`, { method: 'POST' });
      if (state.socket) state.socket.emit('room:leave', state.currentRoomId);
      state.currentRoomId = null;
      renderEmptyRoom();
      await loadRooms();
    } catch (error) {
      message(error.message);
    }
  });

  $('#roomAdminForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/admin/rooms/${state.currentRoomId}`, {
        method: 'PATCH',
        body: formData(event.currentTarget)
      });
      await loadRoom(state.currentRoomId);
      await loadRooms();
    } catch (error) {
      message(error.message);
    }
  });

  $('#dissolveRoomBtn').addEventListener('click', () => dissolveRoom(state.currentRoomId));
  $('#refreshAdminBtn').addEventListener('click', loadAdminData);
}

bindForms();
loadMe();
