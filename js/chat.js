// js/chat.js — Trench Chat UI on Nostr (NIP-28 kind-42). Renders into
// #trench-chat. SECURITY: every piece of remote data (message text, nicks,
// pubkeys) reaches the DOM ONLY via textContent / createTextNode. No innerHTML,
// no linkification, no HTML parsing of any relay-sourced string, ever.
//
//   export function initChat({ config }) -> { destroy } | undefined
//
// Chat failure must never touch the battle: initChat is defensive and main.js
// wraps it in try/catch besides.

import {
  RelayPool,
  buildSignedEvent,
  burnerIdentity,
  defaultNick,
} from './nostr.js';

const MAX_ROWS = 60;
const PRESENCE_WINDOW_S = 600; // "in the trench" = unique pubkeys last 10 min
const NICK_MAX = 24;

// --- tiny DOM helpers (no innerHTML anywhere) -------------------------------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // textContent = safe
  return node;
}

function safeStorage() {
  try {
    const s = window.localStorage;
    const probe = '__tbfb_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch (_) {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  }
}

function sanitizeNick(raw) {
  if (typeof raw !== 'string') return '';
  // strip control chars incl. newlines; collapse whitespace; clamp length
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, NICK_MAX);
}

function readNickTag(tags) {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === 'n' && typeof t[1] === 'string') {
      const s = sanitizeNick(t[1]);
      if (s) return s;
    }
  }
  return null;
}

// SECURITY: the pool verifies id+sig but trusts the relay to honor the REQ's
// `#e` filter. A malicious/buggy relay can return a well-signed kind-42 for a
// DIFFERENT channel (or none). Only accept events that actually reference our
// channel via an `["e", channelId, ...]` tag.
function hasChannelTag(tags, channelId) {
  if (!Array.isArray(tags)) return false;
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === 'e' && t[1] === channelId) return true;
  }
  return false;
}

function hueFromPub(pub) {
  return parseInt(pub.slice(0, 6), 16) % 360 || 0;
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
  } catch (_) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve(ok);
  } catch (_) {
    return Promise.resolve(false);
  }
}

export function initChat({ config } = {}) {
  const cfg = config && config.chat;
  if (!cfg || cfg.enabled === false) return undefined;

  const root = document.getElementById('trench-chat');
  if (!root) return undefined;

  const channelId = cfg.channelId;
  const maxLen = cfg.maxLen || 240;
  const cooldownMs = cfg.cooldownMs || 3000;
  const historyHours = cfg.historyHours || 6;
  const readRelays = cfg.readRelays || [];
  const writeRelays = cfg.writeRelays || [];
  const countRelays = cfg.countRelays || [];
  const relayHint = writeRelays[0] || readRelays[0] || '';

  const storage = safeStorage();
  const identity = burnerIdentity(storage);

  // ---- build the panel (all elements created empty; text via textContent) --
  root.textContent = '';

  const head = el('div', 'tc-head');
  const title = el('span', 'tc-title', 'TRENCH CHAT');
  const chip = el('span', 'tc-chip', '▸ on Nostr');
  const presence = el('span', 'tc-presence');
  const presenceNum = el('b', null, '0');
  presence.appendChild(presenceNum);
  presence.appendChild(document.createTextNode(' in the trench'));
  const closeBtn = el('button', 'tc-close', '✕');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close chat');
  head.appendChild(title);
  head.appendChild(chip);
  head.appendChild(presence);
  head.appendChild(closeBtn);

  const statusEl = el('div', 'tc-status', 'connecting to the trench…');

  const list = el('div', 'tc-messages');
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');

  const hint = el('div', 'tc-hint');
  hint.hidden = true;

  const identityRow = el('div', 'tc-identity');

  const form = el('form', 'tc-composer');
  const input = el('input', 'tc-input');
  input.type = 'text';
  input.maxLength = maxLen;
  input.placeholder = 'Say something to the trench…';
  input.setAttribute('aria-label', 'Chat message');
  input.autocomplete = 'off';
  const sendBtn = el('button', 'tc-send', 'SEND');
  sendBtn.type = 'submit';
  form.appendChild(input);
  form.appendChild(sendBtn);

  const footer = el('div', 'tc-footer');
  const microcopy = el('p', 'tc-micro',
    'Ephemeral-ish. Public. On Nostr, because BIP-110 told us to move our data there.');
  const chanLine = el('p', 'tc-channel');
  chanLine.appendChild(document.createTextNode('channel '));
  const chanId = el('button', 'tc-channel-id',
    `${channelId.slice(0, 8)}…${channelId.slice(-6)}`);
  chanId.type = 'button';
  chanId.title = channelId; // full id in title attr; click-to-copy
  chanLine.appendChild(chanId);
  footer.appendChild(microcopy);
  footer.appendChild(chanLine);

  root.appendChild(head);
  root.appendChild(statusEl);
  root.appendChild(list);
  root.appendChild(hint);
  root.appendChild(identityRow);
  root.appendChild(form);
  root.appendChild(footer);

  // Floating mobile toggle (CSS shows it only under 900px).
  const fab = el('button', 'tc-fab', '💬');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Toggle trench chat');
  document.body.appendChild(fab);

  // ---- state ---------------------------------------------------------------
  const messages = [];      // sorted ascending by [created_at, id]
  const byId = new Set();   // dedupe guard (pool already dedupes per sub)
  const seenPub = new Map();// pubkey -> latest created_at (presence)
  let loaded = false;       // history flushed (EOSE or fallback)
  let anyOpen = false;      // >=1 relay socket open
  let everConnected = false;// at least one relay has connected at some point
  let graceElapsed = false; // startup grace window has passed
  const buffer = [];        // events buffered until first EOSE/flush
  let lastSendAt = 0;
  let cooldownTimer = null;
  let presenceTimer = null;
  let eoseFallback = null;
  let graceTimer = null;
  let hintTimer = null;
  let destroyed = false;

  function showHint(text, kind) {
    hint.textContent = text;
    hint.hidden = false;
    hint.classList.remove('warn', 'err', 'ok');
    if (kind) hint.classList.add(kind);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hint.hidden = true; }, 4200);
  }

  function updateStatus() {
    if (!anyOpen) {
      // Distinguish "still dialing in" from a genuine outage so the first
      // ~half-second on load doesn't scream JAMMED before any relay answers.
      if (everConnected || graceElapsed) {
        statusEl.textContent = 'trench comms jammed — reconnecting…';
        statusEl.className = 'tc-status jammed';
      } else {
        statusEl.textContent = 'connecting to the trench…';
        statusEl.className = 'tc-status';
      }
      statusEl.hidden = false;
    } else if (!loaded) {
      statusEl.textContent = 'loading trench history…';
      statusEl.className = 'tc-status';
      statusEl.hidden = false;
    } else {
      statusEl.hidden = true;
    }
  }

  function refreshPresence() {
    const now = Math.floor(Date.now() / 1000);
    let n = 0;
    for (const [, ts] of seenPub) if (ts >= now - PRESENCE_WINDOW_S) n++;
    presenceNum.textContent = String(n);
  }

  function notePresence(e) {
    const prev = seenPub.get(e.pubkey) || 0;
    if (e.created_at > prev) seenPub.set(e.pubkey, e.created_at);
  }

  function cmp(a, b) {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }

  function toMsg(e, local) {
    return {
      id: e.id,
      pubkey: e.pubkey,
      created_at: e.created_at,
      content: e.content,
      nick: readNickTag(e.tags) || defaultNick(e.pubkey),
      mine: !!(local && local.mine),
      state: (local && local.state) || null,
    };
  }

  function makeRow(m) {
    const row = el('div', 'tc-row' + (m.mine ? ' mine' : '') + (m.state ? ' state-' + m.state : ''));
    const nick = el('span', 'tc-nick', m.nick);
    nick.style.color = `hsl(${hueFromPub(m.pubkey)} 70% 68%)`;
    nick.title = m.pubkey;
    const body = el('span', 'tc-text', m.content); // textContent — inert
    row.appendChild(nick);
    row.appendChild(body);
    if (m.mine && m.state === 'failed') {
      const warn = el('span', 'tc-badge', '⚠');
      warn.title = 'Not delivered to a durable relay — check your system clock?';
      row.appendChild(warn);
    }
    return row;
  }

  function nearBottom() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  function renderAll() {
    const stick = nearBottom();
    const prevTop = list.scrollTop;
    list.textContent = '';
    if (messages.length === 0) {
      const empty = el('div', 'tc-empty', 'No transmissions yet. Break the silence.');
      list.appendChild(empty);
    } else {
      for (const m of messages) list.appendChild(makeRow(m));
    }
    if (stick) list.scrollTop = list.scrollHeight;
    else list.scrollTop = prevTop;
  }

  function addEvent(e, local) {
    notePresence(e);
    if (byId.has(e.id)) {
      // Already shown (e.g. our optimistic copy echoed back): merge nick only.
      refreshPresence();
      return;
    }
    byId.add(e.id);
    const m = toMsg(e, local);
    let i = messages.length;
    while (i > 0 && cmp(messages[i - 1], m) > 0) i--;
    messages.splice(i, 0, m);
    while (messages.length > MAX_ROWS) {
      const dropped = messages.shift();
      byId.delete(dropped.id);
    }
    renderAll();
    refreshPresence();
    if (!fabOpen() && isMobile()) fab.classList.add('has-unread');
  }

  function flushBuffer() {
    if (loaded) return;
    loaded = true;
    clearTimeout(eoseFallback);
    for (const e of buffer) {
      if (byId.has(e.id)) continue;
      byId.add(e.id);
      const m = toMsg(e);
      messages.push(m);
      notePresence(e);
    }
    buffer.length = 0;
    messages.sort(cmp);
    while (messages.length > MAX_ROWS) { const d = messages.shift(); byId.delete(d.id); }
    renderAll();
    list.scrollTop = list.scrollHeight;
    refreshPresence();
    updateStatus();
  }

  // ---- identity row --------------------------------------------------------
  function renderIdentity() {
    identityRow.textContent = '';
    identityRow.appendChild(document.createTextNode('you: '));
    const you = el('span', 'tc-you', identity.nick);
    you.style.color = `hsl(${hueFromPub(identity.pub)} 70% 68%)`;
    you.title = identity.pub;
    const edit = el('button', 'tc-edit', '✎');
    edit.type = 'button';
    edit.title = 'Change your trench name';
    edit.setAttribute('aria-label', 'Change your trench name');
    edit.addEventListener('click', openNickEditor);
    identityRow.appendChild(you);
    identityRow.appendChild(edit);
  }

  function openNickEditor() {
    identityRow.textContent = '';
    const nickInput = el('input', 'tc-nick-input');
    nickInput.type = 'text';
    nickInput.maxLength = NICK_MAX;
    nickInput.value = identity.nick;
    nickInput.setAttribute('aria-label', 'New trench name');
    const save = el('button', 'tc-nick-save', '✓');
    save.type = 'button';
    save.title = 'Save';
    const cancel = el('button', 'tc-nick-cancel', '✕');
    cancel.type = 'button';
    cancel.title = 'Cancel';
    const commit = () => {
      const v = sanitizeNick(nickInput.value);
      if (v) {
        identity.nick = v;
        try { storage.setItem('tbfb-nick', v); } catch (_) { /* ignore */ }
      } else {
        identity.nick = defaultNick(identity.pub);
        try { storage.removeItem('tbfb-nick'); } catch (_) { /* ignore */ }
      }
      renderIdentity();
    };
    save.addEventListener('click', commit);
    cancel.addEventListener('click', renderIdentity);
    nickInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); renderIdentity(); }
    });
    identityRow.appendChild(document.createTextNode('name: '));
    identityRow.appendChild(nickInput);
    identityRow.appendChild(save);
    identityRow.appendChild(cancel);
    nickInput.focus();
    nickInput.select();
  }

  // ---- cooldown + send -----------------------------------------------------
  function startCooldown() {
    const started = Date.now();
    sendBtn.disabled = true;
    sendBtn.textContent = `WAIT ${Math.ceil(cooldownMs / 1000)}`;
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      const left = cooldownMs - (Date.now() - started);
      if (left <= 0) {
        clearInterval(cooldownTimer);
        sendBtn.disabled = false;
        sendBtn.textContent = 'SEND';
        return;
      }
      sendBtn.textContent = `WAIT ${Math.ceil(left / 1000)}`;
    }, 250);
  }

  function trySend() {
    const text = input.value.trim();
    if (!text) return;
    const now = Date.now();
    const remaining = cooldownMs - (now - lastSendAt);
    if (remaining > 0) {
      showHint(`Easy, soldier — hold fire for ${Math.ceil(remaining / 1000)}s.`, 'warn');
      input.classList.remove('shake');
      void input.offsetWidth; // reflow to restart animation
      input.classList.add('shake');
      return;
    }
    let ev;
    try {
      ev = buildSignedEvent({
        kind: 42,
        tags: [['e', channelId, relayHint, 'root'], ['n', identity.nick]],
        content: text.slice(0, maxLen),
        privkey: identity.priv,
      });
    } catch (_) {
      showHint('Could not sign your message.', 'err');
      return;
    }
    input.value = '';
    lastSendAt = now;
    startCooldown();
    // Optimistic render; the relay echo dedupes by id (addEvent's byId guard),
    // so our message shows instantly and never doubles. Works even before the
    // history flush — flushBuffer will merge stored events around it.
    addEvent(ev, { mine: true, state: 'pending' });

    pool.publish(ev).then(({ accepted, reasons }) => {
      if (destroyed) return;
      const m = messages.find((x) => x.id === ev.id);
      if (accepted > 0) {
        if (m) { m.state = 'sent'; renderAll(); }
      } else {
        if (m) { m.state = 'failed'; renderAll(); }
        const clockish = reasons.some((r) => /clock|skew|too far|future|past|old/i.test(r.message || ''));
        showHint(
          clockish
            ? 'Message rejected everywhere — check your system clock.'
            : 'Message did not reach a durable relay. It may not have landed.',
          'warn',
        );
      }
    }, () => { /* publish never rejects, but be safe */ });
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); trySend(); });

  // ---- channel-id copy -----------------------------------------------------
  chanId.addEventListener('click', () => {
    copyText(channelId).then((ok) => {
      showHint(ok ? 'channel id copied — join from any Nostr client.' : 'copy failed (clipboard blocked).', ok ? 'ok' : 'warn');
    });
  });

  // ---- mobile sheet --------------------------------------------------------
  function isMobile() {
    return window.matchMedia('(max-width: 900px)').matches;
  }
  function fabOpen() {
    return document.body.classList.contains('chat-sheet-open');
  }
  fab.addEventListener('click', () => {
    const open = document.body.classList.toggle('chat-sheet-open');
    if (open) {
      fab.classList.remove('has-unread');
      list.scrollTop = list.scrollHeight;
      input.focus();
    }
  });
  closeBtn.addEventListener('click', () => {
    document.body.classList.remove('chat-sheet-open');
  });

  // ---- relay pool ----------------------------------------------------------
  const pool = new RelayPool({
    readUrls: readRelays,
    writeUrls: writeRelays,
    countUrls: countRelays,
    backoff: config.backoff,
  });

  pool.onStatus(({ open }) => {
    anyOpen = open > 0;
    if (anyOpen) everConnected = true;
    updateStatus();
  });

  const subId = 'trench-' + Math.random().toString(36).slice(2, 10);
  const since = Math.floor(Date.now() / 1000) - historyHours * 3600;
  pool.subscribe(
    subId,
    [{ kinds: [42], '#e': [channelId], limit: MAX_ROWS, since }],
    (e) => {
      if (!hasChannelTag(e.tags, channelId)) return; // reject cross-channel spoofs
      if (!loaded) { buffer.push(e); notePresence(e); refreshPresence(); return; }
      addEvent(e);
    },
    () => flushBuffer(),
  );

  pool.connect();

  // Fallbacks / timers.
  eoseFallback = setTimeout(flushBuffer, 5000);
  presenceTimer = setInterval(refreshPresence, 15000);
  // After the startup grace window, a still-dark panel is a real outage.
  graceTimer = setTimeout(() => { graceElapsed = true; updateStatus(); }, 6000);

  renderIdentity();
  renderAll();
  updateStatus();

  function destroy() {
    destroyed = true;
    clearInterval(cooldownTimer);
    clearInterval(presenceTimer);
    clearTimeout(eoseFallback);
    clearTimeout(graceTimer);
    clearTimeout(hintTimer);
    try { pool.close(); } catch (_) { /* ignore */ }
    if (fab.parentNode) fab.parentNode.removeChild(fab);
  }

  return { destroy };
}
