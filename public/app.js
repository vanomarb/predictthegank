const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let currentUser = null;

function showError(msg) {
  const el = document.getElementById('authError');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearError() {
  document.getElementById('authError').style.display = 'none';
}
function showStatus(msg) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3500);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  clearError();
  const name = document.getElementById('nameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  try {
    const data = await api('/auth/login', { method: 'POST', body: { name, password } });
    currentUser = data;
    switchToApp();
  } catch (e) { showError(e.message); }
});

document.getElementById('registerBtn').addEventListener('click', async () => {
  clearError();
  const name = document.getElementById('nameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const inviteCode = document.getElementById('inviteInput').value.trim();
  try {
    const data = await api('/auth/register', { method: 'POST', body: { name, password, inviteCode } });
    currentUser = data;
    switchToApp();
  } catch (e) { showError(e.message); }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  currentUser = null;
  switchToAuth();
});

document.getElementById('logBtn').addEventListener('click', async () => {
  try {
    const data = await api('/sightings', { method: 'POST' });
    if (data.alreadyLogged) showStatus('You already logged this one.');
    else if (data.merged) showStatus('Merged with a sighting logged moments ago by someone else.');
    await refresh();
  } catch (e) { showStatus(e.message); }
});

document.getElementById('undoBtn').addEventListener('click', async () => {
  try {
    await api('/sightings/mine/latest', { method: 'DELETE' });
    await refresh();
  } catch (e) { showStatus(e.message); }
});

document.getElementById('genInviteBtn').addEventListener('click', async () => {
  try {
    const data = await api('/auth/invites', { method: 'POST' });
    await loadInvites();
    showStatus('New invite code: ' + data.code);
  } catch (e) { showStatus(e.message); }
});

async function loadInvites() {
  try {
    const data = await api('/auth/invites');
    const el = document.getElementById('inviteList');
    if (data.invites.length === 0) {
      el.innerHTML = '<p class="muted">No invites yet.</p>';
      return;
    }
    el.innerHTML = data.invites.map(i => {
      const status = i.used_by ? `used by ${i.used_by}` : 'unused';
      return `<div class="muted" style="font-family:monospace; padding:4px 0;">${i.code} — ${status}</div>`;
    }).join('');
  } catch (e) { /* not admin, ignore */ }
}

function switchToApp() {
  document.getElementById('authView').style.display = 'none';
  document.getElementById('appView').style.display = 'block';
  document.getElementById('whoami').textContent = `Signed in as ${currentUser.name}`;
  document.getElementById('adminPanel').style.display = currentUser.isAdmin ? 'block' : 'none';
  if (currentUser.isAdmin) loadInvites();
  refresh();
}
function switchToAuth() {
  document.getElementById('appView').style.display = 'none';
  document.getElementById('authView').style.display = 'block';
  document.getElementById('nameInput').value = '';
  document.getElementById('passwordInput').value = '';
  document.getElementById('inviteInput').value = '';
}

async function refresh() {
  const [{ sightings }, stats] = await Promise.all([
    api('/sightings'),
    api('/sightings/stats'),
  ]);
  renderList(sightings);
  renderHeatmap(stats.heatmap);
  renderPrediction(stats);
  renderByPerson(stats.byPerson);
  document.getElementById('countLabel').textContent = stats.total;
}

function renderList(sightings) {
  const list = document.getElementById('logList');
  if (sightings.length === 0) {
    list.innerHTML = '<div class="muted" style="padding:1rem">No entries yet.</div>';
    return;
  }
  list.innerHTML = sightings.map(s => {
    const d = new Date(s.ts * 1000);
    const label = d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<div><span>${label}</span><span class="muted">${s.logged_by}</span></div>`;
  }).join('');
}

function renderHeatmap(heatmap) {
  const max = Math.max(1, ...heatmap.flat());
  let html = '<table class="heatmap"><tr><td></td>' +
    Array.from({ length: 24 }, (_, h) => `<td style="text-align:center;color:#999">${h}</td>`).join('') + '</tr>';
  for (let d = 0; d < 7; d++) {
    html += `<tr><td style="padding-right:6px;color:#71716c;white-space:nowrap">${DAYS[d]}</td>`;
    for (let h = 0; h < 24; h++) {
      const v = heatmap[d][h];
      const alpha = v === 0 ? 0.06 : 0.15 + 0.85 * (v / max);
      html += `<td style="background:rgba(211,90,48,${alpha})"></td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  document.getElementById('heatmap').innerHTML = html;
}

function renderPrediction(stats) {
  const el = document.getElementById('predictionText');
  if (!stats.prediction || stats.total < 3) {
    el.textContent = 'Log a few more sightings (3+) to see a pattern.';
    return;
  }
  const { day, hour, count, pct } = stats.prediction;
  const hourLabel = hour === 0 ? '12am' : hour < 12 ? hour + 'am' : hour === 12 ? '12pm' : (hour - 12) + 'pm';
  el.textContent = `Most likely: ${DAYS[day]}s around ${hourLabel} (${count} of ${stats.total} sightings, ${pct}%).`;
}

function renderByPerson(byPerson) {
  const el = document.getElementById('byPerson');
  const names = Object.keys(byPerson);
  if (names.length === 0) {
    el.innerHTML = '<span class="muted">No entries yet.</span>';
    return;
  }
  el.innerHTML = names.map(n => `<span class="pill">${n} <span class="muted">${byPerson[n]}</span></span>`).join('');
}

// Try to restore session on load.
(async () => {
  try {
    const data = await api('/auth/me');
    currentUser = data;
    switchToApp();
  } catch (e) {
    switchToAuth();
  }
})();
