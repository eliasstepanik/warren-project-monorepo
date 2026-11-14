// Multiplayer lobby: name, create/join, player list, share link, leave.
// Talks to the game through game.startMultiplayer / stopMultiplayer (main.js).
import { PAL, SHIP_COLORS } from './palette.js';
import { Net } from './net.js';
import { MpClient } from './mp-client.js';

const NAME_KEY = 'lone-orbit-name';
const NEEDS_SERVER = 'Multiplayer needs the Node server: npm start';

function loadName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return ''; // storage blocked
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch { /* storage blocked: the name just is not remembered */ }
}

export function initLobby(game) {
  const $ = (id) => document.getElementById(id);
  const nameEl = $('mp-name');
  const codeEl = $('mp-code');
  const createBtn = $('mp-create');
  const joinBtn = $('mp-join');
  const statusEl = $('mp-status');
  const roomEl = $('mp-room');
  const playersEl = $('mp-players');
  const shareEl = $('mp-share');
  const copyBtn = $('mp-copy');
  const leaveBtn = $('mp-leave');

  let net = null;
  let offs = [];

  function status(text, kind = '') {
    statusEl.textContent = text;
    statusEl.className = `status ${kind}`.trim();
  }

  function setBusy(busy) {
    createBtn.disabled = busy;
    joinBtn.disabled = busy;
  }

  function drawPlayers(list, myId) {
    playersEl.textContent = '';
    for (const p of list ?? []) {
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = PAL[SHIP_COLORS[p.color % 4]];
      sw.setAttribute('aria-hidden', 'true');
      li.append(sw, document.createTextNode(p.id === myId ? `${p.name} (you)` : p.name));
      playersEl.append(li);
    }
  }

  function showRoom(code) {
    const url = new URL(location.href);
    url.search = `?room=${code}`;
    url.hash = '';
    shareEl.value = url.href;
    roomEl.hidden = false;
  }

  function teardown() {
    for (const off of offs) off();
    offs = [];
    if (net) net.close();
    net = null;
    game.stopMultiplayer();
  }

  function reset(text) {
    teardown();
    roomEl.hidden = true;
    leaveBtn.hidden = true;
    setBusy(false);
    status(text);
  }

  function connect(start) {
    const name = nameEl.value.trim();
    saveName(name);
    teardown();
    const n = new Net();
    const client = new MpClient();
    net = n;
    let opened = false;
    let joined = false;
    setBusy(true);
    leaveBtn.hidden = false;
    status('Connecting...');
    offs = [
      n.on('open', () => { opened = true; }),
      n.on('welcome', (msg) => {
        joined = true;
        client.onWelcome(msg);
        game.startMultiplayer(n, client);
        drawPlayers(msg.players, msg.id);
        showRoom(msg.room);
        codeEl.value = msg.room;
        setBusy(false);
        status(`In room ${msg.room}.`, 'ok');
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        $('demo').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
        game.canvas.focus({ preventScroll: true });
        game.setFocused(document.activeElement === game.canvas);
      }),
      n.on('players', (msg) => drawPlayers(msg.list, client.myId)),
      n.on('error', (msg) => {
        if (!opened) {
          reset(NEEDS_SERVER);
          status(NEEDS_SERVER, 'error');
        } else if (!joined) { // the server refused the request: full room, unknown room...
          reset('');
          status(`Error: ${msg.msg}`, 'error');
        } else {
          status(`Error: ${msg.msg}`, 'error');
        }
      }),
      n.on('close', () => {
        if (!joined) { // failed before joining; the error handler has said why
          if (net === n) reset(statusEl.textContent || NEEDS_SERVER);
          return;
        }
        status('Disconnected from the server.', 'error');
        setBusy(false);
        leaveBtn.hidden = false;
      }),
    ];
    start(n, name || 'PILOT');
  }

  createBtn.addEventListener('click', () => connect((n, name) => n.create(name)));
  joinBtn.addEventListener('click', () => {
    const code = codeEl.value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      status('Enter the 4-letter room code.', 'error');
      codeEl.focus();
      return;
    }
    connect((n, name) => n.join(code, name));
  });
  codeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });
  codeEl.addEventListener('input', () => {
    codeEl.value = codeEl.value.replace(/[^A-Za-z]/g, '').toUpperCase();
  });
  nameEl.addEventListener('change', () => saveName(nameEl.value.trim()));

  leaveBtn.addEventListener('click', () => {
    reset('Back in singleplayer.');
    game.canvas.focus({ preventScroll: true });
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareEl.value);
    } catch {
      shareEl.select();
      document.execCommand?.('copy');
    }
    status('Link copied.', 'ok');
  });

  // Page load: ?room=CODE pre-fills the code; a saved name means we can join at once.
  nameEl.value = loadName();
  const wanted = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (/^[A-Z]{4}$/.test(wanted)) {
    codeEl.value = wanted;
    if (nameEl.value.trim()) joinBtn.click();
    else {
      status(`Enter a name to join room ${wanted}.`);
      nameEl.focus({ preventScroll: true });
    }
  }
}
