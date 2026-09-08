(() => {
  const POLL_MS = 5000;
  const HAS_NICKNAME_KEY = 'hasNickname';

  const alertBtn = document.getElementById('alertBtn');
  const alertBtnHint = document.getElementById('alertBtnHint');
  const modal = document.getElementById('nicknameModal');
  const nicknameForm = document.getElementById('nicknameForm');
  const nicknameInput = document.getElementById('nicknameInput');
  const nicknameError = document.getElementById('nicknameError');
  const nicknameSubmitBtn = document.getElementById('nicknameSubmitBtn');

  Tracker.initThemeToggle(document.getElementById('themeToggle'));

  function showToast(msg, opts) {
    Tracker.toast(document.getElementById('toastHost'), msg, opts);
  }

  Tracker.initNotifyToggle(document.getElementById('notifyToggle'), (on, permission) => {
    if (permission === 'denied') showToast('Your browser is blocking notifications for this site.');
    else showToast(on ? 'Roam alerts on.' : 'Roam alerts off.');
  });
  Tracker.initSoundPicker(document.getElementById('soundPicker'), () => showToast('Alarm sound updated.'));

  let currentUser = null;

  function showNicknameModal() {
    modal.style.display = 'flex';
    alertBtn.disabled = true;
    if (alertBtnHint) alertBtnHint.textContent = 'Pick a nickname to unlock the button.';
    nicknameInput.focus();
  }
  function hideNicknameModal() {
    modal.style.display = 'none';
    alertBtn.disabled = false;
    if (alertBtnHint) alertBtnHint.textContent = 'Press it to alert everyone.';
  }
  function showNicknameError(msg) {
    nicknameError.textContent = msg;
    nicknameError.style.display = 'block';
  }
  function clearNicknameError() {
    nicknameError.style.display = 'none';
  }

  // The synchronous localStorage flag is only an optimistic fast path (lets
  // a repeat visitor's button render enabled instantly instead of flashing
  // disabled while the network call resolves). The real identity is always
  // the session cookie, checked via /auth/me below — this is what lets a
  // user who already signed in on `/` be recognized here without being
  // re-prompted for a nickname.
  const hasNickname = (() => {
    try { return localStorage.getItem(HAS_NICKNAME_KEY) === '1'; } catch (e) { return false; }
  })();

  function setHasNickname(on) {
    try { localStorage.setItem(HAS_NICKNAME_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
  }

  function reopenNicknamePrompt() {
    setHasNickname(false);
    currentUser = null;
    showNicknameModal();
  }

  if (hasNickname) {
    alertBtn.disabled = false;
  }
  Tracker.api('/auth/me')
    .then((data) => {
      currentUser = data;
      setHasNickname(true);
      if (modal.style.display === 'flex') hideNicknameModal();
      else alertBtn.disabled = false;
    })
    .catch(() => {
      if (hasNickname) reopenNicknamePrompt();
      else showNicknameModal();
    });

  nicknameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearNicknameError();
    nicknameSubmitBtn.disabled = true;
    try {
      const data = await Tracker.api('/auth/enter', {
        method: 'POST',
        body: { name: nicknameInput.value.trim() },
      });
      currentUser = data;
      setHasNickname(true);
      hideNicknameModal();
    } catch (err) {
      showNicknameError(err.message);
    } finally {
      nicknameSubmitBtn.disabled = false;
    }
  });

  alertBtn.addEventListener('click', async () => {
    alertBtn.disabled = true;
    try {
      await Tracker.api('/alerts', { method: 'POST' });
      showToast('Alert sent.');
    } catch (err) {
      if (err.message === 'Not logged in.' || err.message === 'Session expired. Log in again.') {
        reopenNicknamePrompt();
      } else {
        showToast(err.message);
      }
    } finally {
      // Re-enable unless the nickname prompt just took over (it manages
      // alertBtn.disabled itself while open).
      if (modal.style.display !== 'flex') alertBtn.disabled = false;
    }
  });

  // Highest alert id already surfaced on this device — same key/pattern as
  // public.js and admin.js, shared across every page on this device.
  let lastAlertId = 0;
  try { lastAlertId = Number.parseInt(localStorage.getItem('lastAlertId'), 10) || 0; } catch (e) { /* private mode */ }
  function setLastAlertId(id) {
    lastAlertId = id;
    try { localStorage.setItem('lastAlertId', String(id)); } catch (e) { /* private mode */ }
  }

  async function pollAlerts() {
    const { alerts } = await Tracker.api(`/alerts?since=${lastAlertId}`);
    if (alerts.length === 0) return;
    alerts.forEach((a) => {
      if (!currentUser || a.firedBy !== currentUser.id) {
        Tracker.notify('Alert', `${a.firedByName} pressed the alert button`, 'team-alert');
        showToast(`${a.firedByName} pressed the alert button.`, { fire: true });
        Tracker.playAlarmSound();
      }
    });
    setLastAlertId(Math.max(...alerts.map((a) => a.id)));
  }
  Tracker.createPoller(pollAlerts, POLL_MS).start();
})();
