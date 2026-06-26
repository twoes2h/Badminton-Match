let pageUser = null;

(async () => {
  pageUser = await requireUser();
  if (!pageUser) return;

  renderUserAction(pageUser);
  document.body.insertAdjacentHTML('beforeend', bottomNav('rooms', pageUser));
  bindRoomsPage();
  await loadRooms();
})();

function bindRoomsPage() {
  $('#searchRoomForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await loadRooms(formObject(event.currentTarget).q || '');
  });

  $('#refreshRoomsBtn').addEventListener('click', () => loadRooms());

  $('#createRoomForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const data = await api('/api/rooms', {
        method: 'POST',
        body: formObject(event.currentTarget)
      });
      window.location.href = `/room.html?id=${data.room.id}`;
    } catch (error) {
      showMessage(error.message);
    }
  });
}

async function loadRooms(q = '') {
  try {
    const data = await api(`/api/rooms${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    $('#roomList').innerHTML = data.rooms.length
      ? data.rooms.map(renderRoomItem).join('')
      : '<p class="muted">暂无房间，可以先创建一个。</p>';

    $$('[data-join-room]').forEach((button) => {
      button.addEventListener('click', () => joinRoom(button.dataset.joinRoom));
    });
  } catch (error) {
    showMessage(error.message);
  }
}

function renderRoomItem(room) {
  return `
    <article class="item">
      <div class="item-head">
        <div>
          <strong>${escapeHtml(room.name)}</strong>
          <p class="meta">${escapeHtml(room.code)} · ${room.mode === 'round' ? '固定场次' : '自由匹配'}</p>
        </div>
        <span class="pill">${room.online_count || 0}/${room.max_people}</span>
      </div>
      <p class="meta">${room.court_count} 个场地</p>
      <button type="button" data-join-room="${room.id}">进入房间</button>
    </article>
  `;
}

async function joinRoom(roomId) {
  const password = window.prompt('房间密码，没有则留空') || '';
  try {
    await api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: { password }
    });
    window.location.href = `/room.html?id=${roomId}`;
  } catch (error) {
    showMessage(error.message);
  }
}
