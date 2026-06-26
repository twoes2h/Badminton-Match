(async () => {
  try {
    await currentUser();
    window.location.replace('/rooms.html');
    return;
  } catch {
    // Stay on login page.
  }

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: formObject(event.currentTarget)
      });
      window.location.href = '/rooms.html';
    } catch (error) {
      showMessage(error.message);
    }
  });

  $('#registerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/auth/register', {
        method: 'POST',
        body: formObject(event.currentTarget)
      });
      window.location.href = '/rooms.html';
    } catch (error) {
      showMessage(error.message);
    }
  });
})();
