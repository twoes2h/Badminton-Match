let profileUser = null;
let selectedAvatarDataUrl = null;
let selectedAvatarFileMode = 'none';
let avatarCropImage = null;
let avatarCropState = { x: 0, y: 0, zoom: 1, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 };
const AVATAR_SOURCE_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_ANIMATED_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_CANVAS_SIZE = 320;

(async () => {
  profileUser = await requireUser();
  if (!profileUser) return;
  renderUserAction(profileUser);
  document.body.insertAdjacentHTML('beforeend', bottomNav('profile', profileUser));
  bindProfilePage();
  await loadProfile();
})();

function bindProfilePage() {
  ensureAvatarCropPanel();
  $('#profileForm').addEventListener('submit', saveProfile);
  $('#passwordForm').addEventListener('submit', changePassword);
  $('#avatarFileInput').addEventListener('change', previewAvatarFile);
  $('#uploadAvatarBtn').addEventListener('click', uploadAvatar);
  $('#profileForm').displayName.addEventListener('input', updateAvatarPreview);
  $('#profileForm').gender.addEventListener('change', updateAvatarPreview);
  $('#avatarZoomInput').addEventListener('input', () => {
    avatarCropState.zoom = Number($('#avatarZoomInput').value || 1);
    centerCropIfNeeded();
    drawAvatarCrop();
  });
  const canvas = $('#avatarCropCanvas');
  canvas.addEventListener('pointerdown', startAvatarDrag);
  canvas.addEventListener('pointermove', dragAvatarCrop);
  canvas.addEventListener('pointerup', endAvatarDrag);
  canvas.addEventListener('pointercancel', endAvatarDrag);
}

function ensureAvatarCropPanel() {
  if ($('#avatarCropPanel')) return;
  $('.profile-avatar-row').insertAdjacentHTML('afterend', `
    <section id="avatarCropPanel" class="avatar-crop-panel hide">
      <canvas id="avatarCropCanvas" width="${AVATAR_CANVAS_SIZE}" height="${AVATAR_CANVAS_SIZE}"></canvas>
      <label>
        缩放
        <input id="avatarZoomInput" type="range" min="1" max="3" step="0.01" value="1">
      </label>
      <p class="meta">拖动画面选择头像范围。</p>
    </section>
  `);
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
    avatarUrl: user.avatar_url,
    role: user.role,
    accountType: user.account_type
  };

  $('#profileMeta').textContent = `${user.matches_played || 0} 场 · 等级 ${user.skill_level}`;
  $('#profileUsername').textContent = user.username;
  $('#profileRating').textContent = `${user.rating} 分`;
  $('#accountTypePill').textContent = user.account_type === 'temporary' ? '临时账号' : '正式账号';
  $('#accountTypePill').classList.toggle('resting', user.account_type === 'temporary');

  const canUpdate = Number(user.can_update_profile) === 1;
  $('#profileEditPill').textContent = canUpdate ? '可随时保存' : '暂不可改';
  $('#profileEditPill').classList.toggle('busy', !canUpdate);
  $('#saveProfileBtn').disabled = false;

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
  selectedAvatarDataUrl = null;
  selectedAvatarFileMode = 'none';
  avatarCropImage = null;
  $('#avatarCropPanel').classList.add('hide');
  updateAvatarButton();
  updateAvatarPreview();
}

function updateAvatarPreview() {
  const form = $('#profileForm');
  const preview = $('#profileAvatarPreview');
  const user = {
    display_name: form.displayName.value || profileUser.displayName,
    avatar_url: selectedAvatarDataUrl || profileUser.avatarUrl,
    gender: form.gender.value || 'other'
  };
  preview.outerHTML = avatarHtml(user, 'large').replace('<div class="avatar', '<div id="profileAvatarPreview" class="avatar');
}

async function previewAvatarFile(event) {
  const file = event.currentTarget.files[0];
  if (!file) {
    selectedAvatarDataUrl = null;
    selectedAvatarFileMode = 'none';
    avatarCropImage = null;
    $('#avatarCropPanel').classList.add('hide');
    updateAvatarButton();
    updateAvatarPreview();
    return;
  }
  try {
    const prepared = await prepareAvatarFile(file);
    selectedAvatarDataUrl = prepared.dataUrl;
    selectedAvatarFileMode = prepared.mode;
    if (prepared.cropImage) {
      avatarCropImage = prepared.cropImage;
      resetAvatarCrop();
      $('#avatarCropPanel').classList.remove('hide');
      drawAvatarCrop();
    } else {
      avatarCropImage = null;
      $('#avatarCropPanel').classList.add('hide');
    }
    updateAvatarButton();
    updateAvatarPreview();
  } catch (error) {
    event.currentTarget.value = '';
    selectedAvatarDataUrl = null;
    selectedAvatarFileMode = 'none';
    avatarCropImage = null;
    $('#avatarCropPanel').classList.add('hide');
    updateAvatarButton();
    updateAvatarPreview();
    showMessage(error.message);
  }
}

function updateAvatarButton() {
  $('#uploadAvatarBtn').disabled = !selectedAvatarDataUrl;
}

async function prepareAvatarFile(file) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!allowed.has(file.type)) {
    throw new Error('请选择 jpg、png、webp 或 gif 图片');
  }
  if (file.size > AVATAR_SOURCE_MAX_BYTES) {
    throw new Error('头像原图需小于 5MB');
  }

  const [dataUrl, image, bytes] = await Promise.all([
    readFileAsDataUrl(file),
    loadImageFromFile(file),
    file.arrayBuffer()
  ]);
  const isAnimatedGif = file.type === 'image/gif' && isAnimatedGifBuffer(bytes);
  if (isAnimatedGif
    && file.size <= AVATAR_ANIMATED_MAX_BYTES
    && image.naturalWidth <= AVATAR_CANVAS_SIZE
    && image.naturalHeight <= AVATAR_CANVAS_SIZE) {
    return { dataUrl, mode: 'animated', cropImage: null };
  }

  return {
    dataUrl: resizeAvatarImage(image),
    mode: isAnimatedGif ? 'cropped-static' : 'cropped',
    cropImage: image
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('头像读取失败'));
    reader.readAsDataURL(file);
  });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('头像图片无法读取'));
    };
    image.src = url;
  });
}

function isAnimatedGifBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let frames = 0;
  for (let i = 0; i < bytes.length - 9; i += 1) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      frames += 1;
      if (frames > 1) return true;
    }
  }
  return false;
}

function readAvatarFile(file) {
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!allowed.has(file.type)) {
    return Promise.reject(new Error('请选择 jpg、png 或 webp 图片'));
  }
  if (file.size > AVATAR_SOURCE_MAX_BYTES) {
    return Promise.reject(new Error('头像原图需小于 5MB'));
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      image.onload = () => {
        try {
          resolve(resizeAvatarImage(image));
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = () => reject(new Error('头像图片无法读取'));
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error('头像读取失败'));
    reader.readAsDataURL(file);
  });
}

function resizeAvatarImage(image) {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_CANVAS_SIZE;
  canvas.height = AVATAR_CANVAS_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法处理头像图片');

  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  if (!sourceSize) throw new Error('头像图片尺寸不正确');
  const sourceX = Math.floor((image.naturalWidth - sourceSize) / 2);
  const sourceY = Math.floor((image.naturalHeight - sourceSize) / 2);

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceSize,
    sourceSize,
    0,
    0,
    AVATAR_CANVAS_SIZE,
    AVATAR_CANVAS_SIZE
  );

  return canvas.toDataURL('image/webp', 0.82);
}

function resetAvatarCrop() {
  avatarCropState = { x: NaN, y: NaN, zoom: 1, dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 };
  $('#avatarZoomInput').value = '1';
  centerCropIfNeeded();
}

function cropDrawRect() {
  if (!avatarCropImage) return null;
  const baseScale = Math.max(
    AVATAR_CANVAS_SIZE / avatarCropImage.naturalWidth,
    AVATAR_CANVAS_SIZE / avatarCropImage.naturalHeight
  );
  const scale = baseScale * Math.max(1, Number(avatarCropState.zoom || 1));
  const width = avatarCropImage.naturalWidth * scale;
  const height = avatarCropImage.naturalHeight * scale;
  return { width, height };
}

function centerCropIfNeeded() {
  const rect = cropDrawRect();
  if (!rect) return;
  const minX = Math.min(0, AVATAR_CANVAS_SIZE - rect.width);
  const minY = Math.min(0, AVATAR_CANVAS_SIZE - rect.height);
  const currentX = Number.isFinite(avatarCropState.x) ? avatarCropState.x : (AVATAR_CANVAS_SIZE - rect.width) / 2;
  const currentY = Number.isFinite(avatarCropState.y) ? avatarCropState.y : (AVATAR_CANVAS_SIZE - rect.height) / 2;
  avatarCropState.x = Math.min(0, Math.max(minX, currentX));
  avatarCropState.y = Math.min(0, Math.max(minY, currentY));
}

function drawAvatarCrop() {
  if (!avatarCropImage) return;
  const canvas = $('#avatarCropCanvas');
  const context = canvas.getContext('2d');
  const rect = cropDrawRect();
  if (!context || !rect) return;
  centerCropIfNeeded();
  context.clearRect(0, 0, AVATAR_CANVAS_SIZE, AVATAR_CANVAS_SIZE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(avatarCropImage, avatarCropState.x, avatarCropState.y, rect.width, rect.height);
  selectedAvatarDataUrl = canvas.toDataURL('image/webp', 0.82);
  updateAvatarButton();
  updateAvatarPreview();
}

function startAvatarDrag(event) {
  if (!avatarCropImage) return;
  avatarCropState.dragging = true;
  avatarCropState.startX = event.clientX;
  avatarCropState.startY = event.clientY;
  avatarCropState.originX = avatarCropState.x;
  avatarCropState.originY = avatarCropState.y;
  event.currentTarget.setPointerCapture(event.pointerId);
}

function dragAvatarCrop(event) {
  if (!avatarCropState.dragging || !avatarCropImage) return;
  const rect = cropDrawRect();
  if (!rect) return;
  const minX = Math.min(0, AVATAR_CANVAS_SIZE - rect.width);
  const minY = Math.min(0, AVATAR_CANVAS_SIZE - rect.height);
  avatarCropState.x = Math.min(0, Math.max(minX, avatarCropState.originX + event.clientX - avatarCropState.startX));
  avatarCropState.y = Math.min(0, Math.max(minY, avatarCropState.originY + event.clientY - avatarCropState.startY));
  drawAvatarCrop();
}

function endAvatarDrag(event) {
  avatarCropState.dragging = false;
  if (event && event.currentTarget.releasePointerCapture) {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
  }
}

async function uploadAvatar() {
  const input = $('#avatarFileInput');
  const file = input.files[0];
  if (!file) {
    showMessage('请先选择头像图片');
    return;
  }
  try {
    const imageData = selectedAvatarDataUrl || await readAvatarFile(file);
    const data = await api('/api/auth/avatar', {
      method: 'POST',
      body: { imageData }
    });
    profileUser.avatarUrl = data.avatarUrl;
    selectedAvatarDataUrl = null;
    selectedAvatarFileMode = 'none';
    avatarCropImage = null;
    $('#avatarCropPanel').classList.add('hide');
    input.value = '';
    updateAvatarButton();
    showMessage('头像已保存');
    await loadProfile();
  } catch (error) {
    showMessage(error.message);
  }
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
