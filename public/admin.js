let adminUser = null;

(async () => {
  adminUser = await requireUser({ admin: true });
  if (!adminUser) return;
  renderUserAction(adminUser);
  document.body.insertAdjacentHTML('beforeend', bottomNav('admin', adminUser));
  $('#refreshAdminBtn').addEventListener('click', loadAdminData);
  $$('[name="roomStatusFilter"]').forEach((input) => {
    input.addEventListener('change', loadAdminData);
  });
  await loadAdminData();
})();

async function loadAdminData() {
  try {
    const roomStatus = $('[name="roomStatusFilter"]:checked').value;
    const [roomData, userData] = await Promise.all([
      api(`/api/admin/rooms?status=${encodeURIComponent(roomStatus)}`),
      api('/api/admin/users')
    ]);
    renderRooms(roomData.rooms);
    renderUsers(userData.users);
  } catch (error) {
    showMessage(error.message);
  }
}

function renderRooms(rooms) {
  const roomStatus = $('[name="roomStatusFilter"]:checked').value;
  if (roomStatus === 'dissolved') {
    renderDissolvedRooms(rooms);
    return;
  }

  $('#adminRooms').innerHTML = rooms.length
    ? rooms.map((room) => `
      <article class="item">
        <div class="item-head">
          <div>
            <strong>${escapeHtml(room.name)}</strong>
            <p class="meta">${escapeHtml(room.code)} · ${room.status}</p>
          </div>
          <span class="pill">${room.online_count || 0}/${room.max_people}</span>
        </div>
        <div class="two">
          <label>
            场地
            <input data-room-court="${room.id}" type="number" min="1" max="20" value="${room.court_count}">
          </label>
          <label>
            上限
            <input data-room-max="${room.id}" type="number" min="2" max="200" value="${room.max_people}">
          </label>
        </div>
        <div class="row wrap">
          ${roomStatus === 'active' ? `
            <button type="button" data-save-room="${room.id}">保存</button>
            <button type="button" class="danger" data-dissolve-room="${room.id}">解散</button>
          ` : '<span class="meta">已解散，仅保留履历</span>'}
        </div>
      </article>
    `).join('')
    : '<p class="muted">暂无房间。</p>';

  $$('[data-save-room]').forEach((button) => {
    button.addEventListener('click', () => saveRoom(button.dataset.saveRoom));
  });
  $$('[data-dissolve-room]').forEach((button) => {
    button.addEventListener('click', () => dissolveRoom(button.dataset.dissolveRoom));
  });
}

function renderDissolvedRooms(rooms) {
  if (!rooms.length) {
    $('#adminRooms').innerHTML = '<p class="muted">暂无已解散房间。</p>';
    return;
  }

  const groups = rooms.reduce((map, room) => {
    const key = monthKey(room.updated_at || room.created_at);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(room);
    return map;
  }, new Map());

  $('#adminRooms').innerHTML = [...groups.entries()].map(([month, monthRooms]) => `
    <details class="month-group">
      <summary>${month} · ${monthRooms.length} 个房间</summary>
      <div class="list">
        ${monthRooms.map(renderDissolvedRoom).join('')}
      </div>
    </details>
  `).join('');
}

function renderDissolvedRoom(room) {
  return `
    <article class="item">
      <div class="item-head">
        <div>
          <strong>${escapeHtml(room.name)}</strong>
          <p class="meta">${escapeHtml(room.code)} · ${room.mode === 'round' ? '固定场次' : '自由匹配'}</p>
        </div>
        <span class="pill">已解散</span>
      </div>
      <p class="meta">${room.court_count} 个场地 · 上限 ${room.max_people} 人 · 成员 ${room.member_count || 0} 人</p>
      <p class="meta">创建：${formatDateTime(room.created_at)}</p>
      <p class="meta">解散：${formatDateTime(room.updated_at)}</p>
    </article>
  `;
}

function monthKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知月份';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}年${month}月`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function renderUsers(users) {
  $('#adminUsers').innerHTML = users.length
    ? users.map((user) => `
      <article class="item">
        <div class="item-head">
          <div>
            <strong>${escapeHtml(user.display_name)}</strong>
            <p class="meta">${escapeHtml(user.username)} · ${user.role} · ${user.rating} 分</p>
          </div>
          <span class="pill ${user.is_blacklisted ? 'locked' : ''}">${user.is_blacklisted ? '已拉黑' : '正常'}</span>
        </div>
        <button type="button" data-blacklist="${user.id}" data-value="${user.is_blacklisted ? '0' : '1'}">
          ${user.is_blacklisted ? '解除拉黑' : '拉黑用户'}
        </button>
      </article>
    `).join('')
    : '<p class="muted">暂无用户。</p>';

  $$('[data-blacklist]').forEach((button) => {
    button.addEventListener('click', () => setBlacklist(button.dataset.blacklist, button.dataset.value === '1'));
  });
}

async function saveRoom(roomId) {
  try {
    await api(`/api/admin/rooms/${roomId}`, {
      method: 'PATCH',
      body: {
        courtCount: $(`[data-room-court="${roomId}"]`).value,
        maxPeople: $(`[data-room-max="${roomId}"]`).value
      }
    });
    showMessage('房间已保存');
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}

async function dissolveRoom(roomId) {
  if (!window.confirm('确认解散房间？')) return;
  try {
    await api(`/api/admin/rooms/${roomId}`, { method: 'DELETE' });
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}

async function setBlacklist(userId, isBlacklisted) {
  try {
    await api(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: { isBlacklisted }
    });
    await loadAdminData();
  } catch (error) {
    showMessage(error.message);
  }
}
