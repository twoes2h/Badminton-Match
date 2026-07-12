let profileUser = null;

(async () => {
  profileUser = await requireUser();
  if (!profileUser) return;
  renderUserAction(profileUser);
  document.body.insertAdjacentHTML('beforeend', bottomNav('profile', profileUser));
  bindProfilePage();
  await loadProfile();
})();

function bindProfilePage() {
  $('#profileForm').addEventListener('submit', saveProfile);
  $('#passwordForm').addEventListener('submit', changePassword);
}

async function loadProfile() {
  try {
    const data = await api('/api/auth/me');
    renderProfile(data.user);
  } catch (error) {
    showMessage(error.message);
  }
}

function renderProfile(user) {
  profileUser = {
    ...profileUser,
    displayName: user.display_name,
    role: user.role,
    accountType: user.account_type
  };

  $('#profileMeta').textContent = `${user.matches_played || 0} 场 · 等级 ${user.skill_level}`;
  $('#profileUsername').textContent = user.username;
  $('#profileRating').textContent = `${user.rating} 分`;
  $('#accountTypePill').textContent = user.account_type === 'temporary' ? '临时账号' : '正式账号';
  $('#accountTypePill').classList.toggle('resting', user.account_type === 'temporary');

  const canUpdate = Number(user.can_update_profile) === 1;
  $('#profileEditPill').textContent = canUpdate ? '今日可改' : '今日已改';
  $('#profileEditPill').classList.toggle('busy', !canUpdate);
  $('#saveProfileBtn').disabled = !canUpdate;

  const notice = $('#temporaryNotice');
  if (user.account_type === 'temporary') {
    notice.textContent = `默认密码为 000000，修改密码后转为正式账号。有效期至 ${formatDate(user.temporary_expires_at)}`;
    notice.classList.add('show');
  } else {
    notice.textContent = '';
    notice.classList.remove('show');
  }

  const form = $('#profileForm');
  form.displayName.value = user.display_name || '';
  form.gender.value = user.gender || 'other';
  form.birthYear.value = user.birth_year || '';
  form.skillLevel.value = user.skill_level || 5;
}

async function saveProfile(event) {
  event.preventDefault();
  const data = formObject(event.currentTarget);
  try {
    await api('/api/auth/profile', {
      method: 'PATCH',
      body: data
    });
    showMessage('资料已保存');
    await loadProfile();
  } catch (error) {
    showMessage(error.message);
  }
}

async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formObject(form);
  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: data
    });
    form.reset();
    showMessage('密码已修改');
    await loadProfile();
  } catch (error) {
    showMessage(error.message);
  }
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}
