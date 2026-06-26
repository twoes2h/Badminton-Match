(async () => {
  try {
    await currentUser();
    window.location.replace('/rooms.html');
  } catch {
    window.location.replace('/login.html');
  }
})();
