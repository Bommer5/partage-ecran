'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

const PREFIX = 'partage-ecran-bommer5-'; // évite les collisions sur le serveur PeerJS public
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O ni 1/I
const randomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ALPHA[b % ALPHA.length]).join('');
const cleanCode = c => c.trim().split('#').pop().toUpperCase().replace(/[^A-Z0-9]/g, '');
const COLORS = ['#5865f2', '#23a55a', '#f0b232', '#f23f43', '#eb459e', '#00b0f4', '#9b59b6', '#e67e22'];
const PRESETS = {
  '1080p60': { label: '1080p · 60 fps', w:1920, h:1080, fps:60, kbps:8000,  hint:'motion' },
  '1080p30': { label: '1080p · 30 fps', w:1920, h:1080, fps:30, kbps:6000,  hint:'detail' },
  '1440p60': { label: '1440p · 60 fps', w:2560, h:1440, fps:60, kbps:14000, hint:'motion' },
  '4k30':    { label: '4K · 30 fps',    w:3840, h:2160, fps:30, kbps:20000, hint:'detail' },
  '720p30':  { label: '720p · 30 fps (connexion lente)', w:1280, h:720, fps:30, kbps:2500, hint:'detail' },
};
const canShare = !!navigator.mediaDevices?.getDisplayMedia;        // absent sur iPad/iPhone
const canSetSink = 'setSinkId' in HTMLMediaElement.prototype;      // choix de la sortie : Chrome/Edge
const canSetVolume = (() => { const a = document.createElement('audio'); a.volume = .5; return a.volume === .5; })(); // faux sur iOS

// ================= Réglages (sauvegardés dans le navigateur) =================
const DEFAULTS = {
  name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)],
  inputId: '', outputId: '', inputVol: 100, outputVol: 100,
  mode: 'vad', vadAuto: true, vadThreshold: -50, pttKey: 'KeyV', pttLabel: 'V', pttDelay: 200,
  noise: true, echo: true, agc: true, voiceKbps: 64,
  quality: '1080p60', hint: 'auto', screenAudio: true, showStats: true,
  sounds: true, userVol: {}, streamVol: {},
};
const S = (() => {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pe-settings') || '{}') };
    if (!s.name) s.name = localStorage.getItem('pseudo') || '';
    return s;
  } catch (e) { return { ...DEFAULTS }; }
})();
function save() { try { localStorage.setItem('pe-settings', JSON.stringify(S)); } catch (e) {} }
const myName = () => S.name.trim() || 'Moi';

const state = { inRoom: false, muted: false, deafened: false, micOk: false };
let peer = null, roomCode = null, isHost = false, screenStream = null, screenOwner = null, statsTimer = null;
// Un ami par connexion : { conn, name, color, muted, deafened, micOk, voiceOut, screenOut, voiceIn, screenIn, screenStreamIn, audioEl, meter, localMute }
const friends = new Map();
function getFriend(id) { if (!friends.has(id)) friends.set(id, { name: 'Ami', color: '#4e5058' }); return friends.get(id); }

function status(msg, cls = 'mut') { $('status').className = cls; $('status').textContent = msg; }
let toastTimer;
function toast(msg) { $('toast').textContent = msg; $('toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 3500); }

// ================= Audio =================
let ctx = null;
function ensureCtx() {
  // À appeler pendant un clic : l'iPad exige un geste pour démarrer l'audio
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx;
}

// Chaîne du micro : micro → volume d'entrée → porte (détection voix / appuyer pour parler) → envoi
const mic = { raw: null, src: null, nodes: null, track: null, level: -100, floor: -60, lastVoice: 0, open: false };
function micGraph() {
  if (mic.nodes) return;
  const c = ensureCtx();
  const gain = c.createGain(), pre = c.createAnalyser(), gate = c.createGain(), dest = c.createMediaStreamDestination();
  pre.fftSize = 1024; gate.gain.value = 0;
  gain.connect(pre); gain.connect(gate); gate.connect(dest);
  mic.nodes = { gain, pre, gate, dest };
  mic.track = dest.stream.getAudioTracks()[0];
  applyInputVol();
}
async function openMic() {
  micGraph();
  const c = { echoCancellation: S.echo, noiseSuppression: S.noise, autoGainControl: S.agc };
  let raw;
  try {
    raw = await navigator.mediaDevices.getUserMedia({ audio: S.inputId ? { ...c, deviceId: { exact: S.inputId } } : c });
  } catch (e) {
    if (!S.inputId || e.name === 'NotAllowedError') throw e;
    raw = await navigator.mediaDevices.getUserMedia({ audio: c }); // périphérique débranché : celui par défaut
  }
  closeMicSource();
  mic.raw = raw;
  mic.src = ctx.createMediaStreamSource(raw);
  mic.src.connect(mic.nodes.gain);
  state.micOk = true;
  raw.getAudioTracks()[0].onended = () => { state.micOk = false; syncVoice(); };
  refreshDevices();
}
function closeMicSource() {
  mic.src?.disconnect();
  mic.raw?.getTracks().forEach(t => t.stop());
  mic.src = mic.raw = null;
}
async function tryOpenMic() {
  try { await openMic(); }
  catch (e) {
    state.micOk = false;
    toast(e.name === 'NotAllowedError' ? '🎙️ Micro refusé : autorise-le dans le navigateur.' : '🎙️ Aucun micro disponible.');
  }
  syncVoice();
}
function applyInputVol() { if (mic.nodes) mic.nodes.gain.gain.value = S.inputVol / 100; }

const buf = new Float32Array(1024);
function dbOf(an) {
  an.getFloatTimeDomainData(buf);
  let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.max(-100, 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9));
}
const threshold = () => S.vadAuto ? Math.min(-25, Math.max(-65, mic.floor + 14)) : S.vadThreshold;

let pttDown = false, pttRelease = 0;
setInterval(() => {
  if (mic.nodes && mic.raw) {
    const lvl = mic.level = dbOf(mic.nodes.pre);
    // bruit de fond : descend vite, remonte lentement (pour la sensibilité auto)
    mic.floor = lvl < mic.floor ? mic.floor * 0.8 + lvl * 0.2 : mic.floor + 0.04;
    let talk;
    if (S.mode === 'ptt') talk = pttDown || performance.now() - pttRelease < S.pttDelay;
    else { if (lvl > threshold()) mic.lastVoice = performance.now(); talk = performance.now() - mic.lastVoice < 350; }
    const open = talk && !state.muted && !state.deafened;
    if (open !== mic.open) { mic.open = open; mic.nodes.gate.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, 0.01); }
    setSpeaking('me', open && lvl > -60);
    if (!$('settings').classList.contains('hidden')) updateMeter(lvl);
  } else setSpeaking('me', false);
  for (const [id, f] of friends) setSpeaking(id, !!f.meter && !f.muted && !f.deafened && dbOf(f.meter) > -50);
}, 40);
function setSpeaking(id, on) {
  document.querySelector(`.person[data-id="${CSS.escape(id)}"]`)?.classList.toggle('speaking', on);
  if (id === 'me') $('panel').classList.toggle('speaking', on);
}

// Sorties : un élément <audio> par personne (garde l'annulation d'écho du navigateur)
function setElVol(el, pct) {
  const v = state.deafened ? 0 : (pct / 100) * (S.outputVol / 100);
  el.muted = v <= 0;
  if (canSetVolume) el.volume = Math.min(1, v);
}
function applySink(el) { if (canSetSink) el.setSinkId(S.outputId || '').catch(() => {}); }
function applyOutputs() {
  for (const f of friends.values()) if (f.audioEl) setElVol(f.audioEl, f.localMute ? 0 : (S.userVol[f.name] ?? 100));
  const owner = friends.get(screenOwner);
  if (owner) setElVol($('remoteVideo'), S.streamVol[owner.name] ?? 100);
  if (testEl) setElVol(testEl, 100);
}
function applySinks() { document.querySelectorAll('audio, #remoteVideo').forEach(applySink); }

// Petits sons façon Discord
function sfx(kind) {
  if (!S.sounds || !ctx || (state.deafened && kind !== 'deafen')) return;
  const seq = { join: [523, 784], leave: [784, 523], mute: [440, 330], unmute: [330, 440], deafen: [392, 262], undeafen: [262, 392] }[kind];
  let t = ctx.currentTime;
  for (const fr of seq) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = fr;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + 0.13); t += 0.09;
  }
}

// ================= Micro / sourdine =================
function syncVoice() {
  if (mic.track) mic.track.enabled = state.micOk && !state.muted && !state.deafened;
  applyOutputs();
  broadcast({ type: 'state', ...myState() });
  renderPeople(); renderPanel();
}
function setMuted(m) {
  if (!m && state.deafened) state.deafened = false; // réactiver le micro enlève aussi la sourdine
  state.muted = m;
  sfx(m ? 'mute' : 'unmute');
  syncVoice();
}
function setDeafened(d) { state.deafened = d; sfx(d ? 'deafen' : 'undeafen'); syncVoice(); }
$('micBtn').onclick = () => {
  ensureCtx();
  if (!state.micOk) return tryOpenMic();
  setMuted(!(state.muted || state.deafened));
};
$('deafBtn').onclick = () => setDeafened(!state.deafened);

// Appuyer pour parler
const isTyping = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
let capturingKey = false;
addEventListener('keydown', e => {
  if (capturingKey) {
    e.preventDefault(); capturingKey = false;
    if (e.key !== 'Escape') { S.pttKey = e.code; S.pttLabel = e.key.length === 1 ? e.key.toUpperCase() : e.code; save(); }
    return renderSettings();
  }
  if (e.key === 'Escape') return closeOverlays();
  if (S.mode === 'ptt' && state.inRoom && e.code === S.pttKey && !isTyping(e)) { pttDown = true; e.preventDefault(); }
});
const releasePtt = () => { if (pttDown) { pttDown = false; pttRelease = performance.now(); } $('pttBtn').classList.remove('active'); };
addEventListener('keyup', e => { if (e.code === S.pttKey) releasePtt(); });
addEventListener('blur', releasePtt);
$('pttBtn').addEventListener('pointerdown', e => { e.preventDefault(); ensureCtx(); pttDown = true; $('pttBtn').classList.add('active'); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => $('pttBtn').addEventListener(ev, releasePtt));

// ================= Réseau (PeerJS) =================
function newPeer(id) {
  const opts = { config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:eu-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
    { urls: 'turn:us-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
  ]}};
  return id ? new Peer(id, opts) : new Peer(opts);
}
function startPeer(id) {
  S.name = $('name').value.trim(); save();
  micGraph();
  peer = newPeer(id);
  peer.on('connection', setupConn);
  peer.on('call', onIncomingCall);
  peer.on('disconnected', () => { if (peer && !peer.destroyed) peer.reconnect(); });
  return peer;
}
const myState = () => ({ name: myName(), color: S.color, muted: state.muted, deafened: state.deafened, micOk: state.micOk });
function broadcast(msg) { for (const f of friends.values()) if (f.conn?.open) f.conn.send(msg); }

function showCode() {
  $('roomCode').textContent = roomCode;
  $('copyBtn').dataset.link = location.href.split('#')[0].split('?')[0] + '#' + roomCode;
}
function createChannel() {
  status('Création du channel…');
  roomCode = randomCode(); isHost = true;
  startPeer(PREFIX + roomCode).on('open', () => { showCode(); enterRoom(); });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { peer.destroy(); return createChannel(); } // code déjà pris : on en tire un autre
    status('Erreur : ' + e.type, 'err');
  });
}
$('createBtn').onclick = createChannel;

function join(code) {
  code = cleanCode(code);
  if (code.length < 4) return status('Entre le code du channel.', 'err');
  status('Connexion…');
  roomCode = code; isHost = false;
  startPeer().on('open', () => {
    setupConn(peer.connect(PREFIX + code, { reliable: true }));
    const me = peer;
    setTimeout(() => { // sans réponse au bout de 8 s, le channel n'existe pas
      if (peer === me && !state.inRoom) { leave(true); status('Ce channel n\'existe pas (ou son créateur l\'a fermé).', 'err'); }
    }, 8000);
  });
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') {
      if (state.inRoom) return; // un membre est parti entre-temps
      status('Ce channel n\'existe pas (ou son créateur l\'a fermé).', 'err');
      return leave(true);
    }
    status('Erreur : ' + e.type, 'err');
  });
}
$('joinBtn').onclick = () => join($('code').value);
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') join($('code').value); });

function setupConn(conn) {
  conn.on('open', () => {
    getFriend(conn.peer).conn = conn;
    conn.send({ type: 'hello', ...myState() });
    // Le créateur présente les membres au nouveau venu, qui se connecte à chacun
    if (isHost) conn.send({ type: 'peers', list: [...friends.keys()].filter(id => id !== conn.peer && friends.get(id).conn) });
    if (!state.inRoom) { showCode(); enterRoom(); }
    sendVoice(conn.peer);
    if (screenStream) sendScreen(conn.peer);
    renderPeople();
  });
  conn.on('data', d => {
    const f = friends.get(conn.peer); if (!f || !d) return;
    if (d.type === 'hello' || d.type === 'state') {
      if (d.type === 'hello' && !f.greeted) { f.greeted = true; sfx('join'); }
      f.name = String(d.name || 'Ami').slice(0, 20);
      f.color = COLORS.includes(d.color) ? d.color : '#4e5058';
      f.muted = !!d.muted; f.deafened = !!d.deafened; f.micOk = !!d.micOk;
      applyOutputs();
    }
    if (d.type === 'screen-off') hideRemoteScreen(conn.peer);
    if (d.type === 'peers') for (const id of d.list || []) {
      if (id !== peer.id && !friends.get(id)?.conn) setupConn(peer.connect(id, { reliable: true }));
    }
    renderPeople();
  });
  conn.on('close', () => dropFriend(conn.peer));
}

function dropFriend(id) {
  const f = friends.get(id); if (!f) return;
  [f.voiceOut, f.screenOut, f.voiceIn, f.screenIn].forEach(c => c?.close());
  f.audioEl?.remove();
  hideRemoteScreen(id);
  friends.delete(id);
  if (f.greeted) sfx('leave');
  if ($('userMenu').dataset.id === id) closeUserMenu();
  renderPeople();
}

// Qualité de la voix : débit Opus
async function tuneAudio(pc) {
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== 'audio') continue;
    const p = s.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = S.voiceKbps * 1000;
    try { await s.setParameters(p); } catch (e) {}
  }
}
function sendVoice(id) {
  const f = friends.get(id); if (!f || !mic.nodes) return;
  f.voiceOut?.close();
  const call = f.voiceOut = peer.call(id, mic.nodes.dest.stream, { metadata: { kind: 'voice' } });
  call.peerConnection.addEventListener('connectionstatechange', () => {
    if (call.peerConnection.connectionState === 'connected') tuneAudio(call.peerConnection);
  });
}

function onIncomingCall(call) {
  call.answer(); // on reçoit seulement : chacun envoie ses propres flux
  const kind = call.metadata?.kind, f = getFriend(call.peer);
  f[kind === 'voice' ? 'voiceIn' : 'screenIn'] = call;
  let done = false;
  call.on('stream', s => {
    if (done) return; // l'événement peut arriver une fois par piste
    if (kind === 'voice') { if (!s.getAudioTracks().length) return; done = true; playVoice(call.peer, s); }
    else { done = true; f.screenStreamIn = s; if (!screenOwner) showRemoteScreen(call.peer, s); else toast(`🖥️ ${f.name} partage son écran — clique sur son nom pour le regarder.`); }
    renderPeople();
  });
  call.on('close', () => { if (kind !== 'voice') hideRemoteScreen(call.peer); });
}

function playVoice(id, s) {
  const f = friends.get(id); if (!f) return;
  f.audioEl?.remove();
  const a = document.createElement('audio');
  a.autoplay = true; a.playsInline = true; a.srcObject = s;
  $('audios').appendChild(a);
  f.audioEl = a;
  applySink(a); applyOutputs();
  a.play().catch(() => $('unmute').classList.remove('hidden'));
  try { const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(s).connect(an); f.meter = an; } catch (e) {}
}

// ================= Partage d'écran =================
async function tuneSender(pc, preset, hint) {
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== 'video') continue;
    const p = s.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = preset.kbps * 1000;
    p.encodings[0].maxFramerate = preset.fps;
    p.degradationPreference = hint === 'detail' ? 'maintain-resolution' : 'balanced';
    try { await s.setParameters(p); } catch (e) { console.warn(e); }
  }
}
function preferCodecs(pc) { // AV1 > VP9 > H264 > VP8
  if (!RTCRtpSender.getCapabilities) return;
  const rank = c => { const i = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'].indexOf(c.mimeType); return i < 0 ? 99 : i; };
  const sorted = [...RTCRtpSender.getCapabilities('video').codecs].sort((a, b) => rank(a) - rank(b));
  for (const t of pc.getTransceivers()) if (t.sender.track?.kind === 'video' && t.setCodecPreferences) try { t.setCodecPreferences(sorted); } catch (e) {}
}

let sharePreset, shareHint;
$('shareBtn').onclick = async () => {
  if (screenStream) return stopScreen();
  sharePreset = PRESETS[S.quality] || PRESETS['1080p60'];
  shareHint = S.hint === 'auto' ? sharePreset.hint : S.hint;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: sharePreset.w }, height: { ideal: sharePreset.h }, frameRate: { ideal: sharePreset.fps, max: sharePreset.fps } },
      audio: S.screenAudio,
    });
  } catch (e) { screenStream = null; return; }
  const vt = screenStream.getVideoTracks()[0];
  vt.contentHint = shareHint;
  vt.onended = stopScreen;
  $('audioWarn').classList.toggle('hidden', !S.screenAudio || screenStream.getAudioTracks().length > 0);
  $('localPreview').srcObject = screenStream;
  $('localPreview').classList.remove('hidden');
  $('emptyMsg').classList.add('hidden');
  $('shareBtn').textContent = '⏹️ Arrêter le partage'; $('shareBtn').className = 'on';
  $('quality').disabled = true;
  for (const id of friends.keys()) sendScreen(id);
  renderPeople();
};
function sendScreen(id) {
  const f = friends.get(id); if (!f) return;
  const call = peer.call(id, screenStream, { metadata: { kind: 'screen' } });
  preferCodecs(call.peerConnection);
  call.peerConnection.addEventListener('connectionstatechange', () => {
    if (call.peerConnection.connectionState === 'connected') { tuneSender(call.peerConnection, sharePreset, shareHint); tuneAudio(call.peerConnection); }
  });
  f.screenOut = call;
}
function stopScreen() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  for (const f of friends.values()) { if (f.conn?.open) f.conn.send({ type: 'screen-off' }); f.screenOut?.close(); f.screenOut = null; }
  $('localPreview').srcObject = null; $('localPreview').classList.add('hidden');
  $('audioWarn').classList.add('hidden');
  $('shareBtn').textContent = '🖥️ Partager l\'écran'; $('shareBtn').className = '';
  $('quality').disabled = false;
  if (!screenOwner) $('emptyMsg').classList.remove('hidden');
  renderPeople();
}

function showRemoteScreen(id, s) {
  const v = $('remoteVideo'), f = friends.get(id);
  screenOwner = id;
  if (v.srcObject !== s) v.srcObject = s;
  v.classList.remove('hidden'); $('emptyMsg').classList.add('hidden');
  $('tools').classList.remove('hidden');
  $('stats').classList.toggle('hidden', !S.showStats);
  $('watching').textContent = `📺 Écran de ${f?.name || 'Ami'}`; $('watching').classList.remove('hidden');
  applySink(v); applyOutputs();
  v.play().catch(() => { v.muted = true; v.play().catch(() => {}); $('unmute').classList.remove('hidden'); });
  startStats(id);
  renderPeople();
}
function hideRemoteScreen(id) {
  const f = friends.get(id); if (f) { f.screenIn = null; f.screenStreamIn = null; }
  if (screenOwner !== id) return renderPeople();
  screenOwner = null;
  const next = [...friends].find(([, g]) => g.screenStreamIn);
  if (next) return showRemoteScreen(next[0], next[1].screenStreamIn);
  const v = $('remoteVideo');
  v.srcObject = null; v.classList.add('hidden');
  ['tools', 'stats', 'watching'].forEach(x => $(x).classList.add('hidden'));
  if (!screenStream) $('emptyMsg').classList.remove('hidden');
  clearInterval(statsTimer); setFake(false);
  renderPeople();
}
function startStats(id) {
  clearInterval(statsTimer);
  let last = null;
  statsTimer = setInterval(async () => {
    const v = $('remoteVideo'), pc = friends.get(id)?.screenIn?.peerConnection;
    let txt = `${v.videoWidth}×${v.videoHeight}`;
    if (pc) (await pc.getStats()).forEach(x => {
      if (x.type === 'inbound-rtp' && x.kind === 'video') {
        if (last) txt += ` · ${Math.round((x.bytesReceived - last.b) * 8 / (x.timestamp - last.t))} kb/s`;
        if (x.framesPerSecond) txt += ` · ${Math.round(x.framesPerSecond)} fps`;
        last = { b: x.bytesReceived, t: x.timestamp };
      }
    });
    $('stats').textContent = txt;
  }, 1000);
}

// Bouton de secours quand le navigateur bloque le son (iPad notamment)
$('unmute').onclick = () => {
  ensureCtx();
  const v = $('remoteVideo'); v.play().catch(() => {});
  document.querySelectorAll('#audios audio').forEach(a => a.play().catch(() => {}));
  applyOutputs();
  $('unmute').classList.add('hidden');
};

// ================= Entrer / quitter =================
async function enterRoom() {
  state.inRoom = true;
  $('home').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('shareBtn').classList.toggle('hidden', !canShare);
  $('quality').classList.toggle('hidden', !canShare);
  renderPeople(); renderPanel();
  if (!mic.raw) await tryOpenMic(); else syncVoice();
  sfx('join');
}
function leave(silent) {
  if (state.inRoom && !silent) sfx('leave');
  stopScreen();
  for (const id of [...friends.keys()]) dropFriend(id);
  peer?.destroy(); peer = null;
  if ($('settings').classList.contains('hidden')) closeMicSource();
  Object.assign(state, { inRoom: false, micOk: !!mic.raw });
  roomCode = null; isHost = false;
  $('room').classList.add('hidden'); $('home').classList.remove('hidden');
  $('unmute').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
  if (!silent) status('Tu as quitté le channel.');
}
$('leaveBtn').onclick = () => leave();
$('copyBtn').onclick = () => { navigator.clipboard.writeText($('copyBtn').dataset.link); toast('🔗 Lien copié'); };
$('copyCodeBtn').onclick = () => { navigator.clipboard.writeText(roomCode); toast('📋 Code copié : ' + roomCode); };

// ================= Affichage =================
const initial = n => esc((n || '?')[0].toUpperCase());
function renderPeople() {
  if (!state.inRoom) return;
  const row = (id, name, color, icons, extra = '') =>
    `<div class="person" data-id="${esc(id)}"><div class="avatar" style="background:${color}">${initial(name)}</div>
     <div class="pname">${esc(name)}${extra}</div><span class="icons">${icons}</span></div>`;
  const myIcons = (!state.micOk || state.muted || state.deafened ? '🔇' : '') + (state.deafened ? '🎧' : '');
  let html = row('me', myName() + ' (toi)', S.color, myIcons, screenStream ? '<span class="live">LIVE</span>' : '');
  for (const [id, f] of friends) {
    if (!f.conn) continue;
    const icons = (!f.micOk || f.muted || f.deafened ? '🔇' : '') + (f.deafened ? '🎧' : '') + (f.localMute ? '🔕' : '');
    html += row(id, f.name, f.color, icons, f.screenStreamIn ? '<span class="live">LIVE</span>' : '');
  }
  $('people').innerHTML = html;
  $('people').querySelectorAll('.person').forEach(el => el.onclick = e => {
    if (el.dataset.id === 'me') return openSettings('profile');
    openUserMenu(el.dataset.id, e);
  });
}
function renderPanel() {
  $('meAvatar').style.background = S.color; $('meAvatar').textContent = myName()[0].toUpperCase();
  $('meName').textContent = myName();
  $('meSub').textContent = !state.micOk ? 'Pas de micro' : state.deafened ? 'Sourdine' : state.muted ? 'Micro coupé' : S.mode === 'ptt' ? `Appuyer sur ${S.pttLabel}` : 'En vocal';
  $('micBtn').classList.toggle('off', !state.micOk || state.muted || state.deafened);
  $('deafBtn').classList.toggle('off', state.deafened);
  $('pttBtn').classList.toggle('hidden', S.mode !== 'ptt');
}

// Menu d'un utilisateur (volume, muet pour moi, regarder son écran)
function openUserMenu(id, e) {
  const f = friends.get(id); if (!f) return;
  const m = $('userMenu');
  m.dataset.id = id;
  $('umName').textContent = f.name;
  $('umVol').value = S.userVol[f.name] ?? 100;
  $('umStream').value = S.streamVol[f.name] ?? 100;
  $('umMute').checked = !!f.localMute;
  $('umWatch').classList.toggle('hidden', !f.screenStreamIn || screenOwner === id);
  $('umStreamBox').classList.toggle('hidden', !f.screenStreamIn || !canSetVolume);
  $('umVol').parentElement && $('umVol').classList.toggle('hidden', !canSetVolume);
  $('umVol').previousElementSibling.classList.toggle('hidden', !canSetVolume);
  $('umNoVol').classList.toggle('hidden', canSetVolume);
  updateUserMenuLabels();
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
}
function closeUserMenu() { $('userMenu').classList.add('hidden'); delete $('userMenu').dataset.id; }
const umFriend = () => friends.get($('userMenu').dataset.id);
function updateUserMenuLabels() { $('umVolVal').textContent = $('umVol').value + ' %'; $('umStreamVal').textContent = $('umStream').value + ' %'; }
$('umVol').oninput = () => { const f = umFriend(); if (!f) return; S.userVol[f.name] = +$('umVol').value; save(); updateUserMenuLabels(); applyOutputs(); };
$('umStream').oninput = () => { const f = umFriend(); if (!f) return; S.streamVol[f.name] = +$('umStream').value; save(); updateUserMenuLabels(); applyOutputs(); };
$('umMute').onchange = () => { const f = umFriend(); if (!f) return; f.localMute = $('umMute').checked; applyOutputs(); renderPeople(); };
$('umWatch').onclick = () => { const id = $('userMenu').dataset.id, f = friends.get(id); if (f?.screenStreamIn) showRemoteScreen(id, f.screenStreamIn); closeUserMenu(); };
document.addEventListener('pointerdown', e => {
  if (!$('userMenu').classList.contains('hidden') && !$('userMenu').contains(e.target) && !e.target.closest('.person')) closeUserMenu();
});

// ================= Paramètres =================
let testEl = null;
function openSettings(tab = 'voice') {
  ensureCtx();
  $('settings').classList.remove('hidden');
  showTab(tab);
  renderSettings();
  if (!mic.raw) openMic().then(() => { state.micOk = true; syncVoice(); }).catch(() => $('permBtn').classList.remove('hidden'));
  refreshDevices();
}
function closeSettings() {
  $('settings').classList.add('hidden');
  stopTest();
  if (!state.inRoom) { closeMicSource(); state.micOk = false; }
  capturingKey = false;
}
function closeOverlays() {
  if (!$('settings').classList.contains('hidden')) return closeSettings();
  if (!$('userMenu').classList.contains('hidden')) return closeUserMenu();
  setFake(false);
}
$('openSettings').onclick = () => openSettings();
$('openSettingsTop').onclick = () => openSettings();
$('closeSettings').onclick = closeSettings;
$('settings').addEventListener('pointerdown', e => { if (e.target === $('settings')) closeSettings(); });
document.querySelectorAll('.tab').forEach(t => t.onclick = () => showTab(t.dataset.tab));
function showTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
}

const qualityOptions = () => Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
$('quality').innerHTML = $('qualitySel').innerHTML = qualityOptions();
$('colors').innerHTML = COLORS.map(c => `<button class="swatch" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('');

function renderSettings() {
  $('inVol').value = S.inputVol; $('inVolVal').textContent = S.inputVol + ' %';
  $('outVol').value = S.outputVol; $('outVolVal').textContent = S.outputVol + ' %';
  $('outVolBox').classList.toggle('hidden', !canSetVolume);
  $('outputBox').classList.toggle('hidden', !canSetSink);
  $('noSink').classList.toggle('hidden', canSetSink);
  document.querySelectorAll('input[name=mode]').forEach(r => r.checked = r.value === S.mode);
  $('vadBox').classList.toggle('hidden', S.mode !== 'vad');
  $('pttBox').classList.toggle('hidden', S.mode !== 'ptt');
  $('vadAuto').checked = S.vadAuto;
  $('vadSlider').disabled = S.vadAuto;
  $('vadSlider').value = S.vadThreshold;
  $('pttKeyBtn').textContent = capturingKey ? 'Appuie sur une touche…' : `⌨️ ${S.pttLabel}`;
  $('pttDelay').value = S.pttDelay; $('pttDelayVal').textContent = S.pttDelay + ' ms';
  $('noise').checked = S.noise; $('echo').checked = S.echo; $('agc').checked = S.agc;
  $('voiceBitrate').value = S.voiceKbps;
  $('qualitySel').value = $('quality').value = S.quality;
  $('hintSel').value = S.hint;
  $('screenAudio').checked = S.screenAudio; $('showStats').checked = S.showStats;
  $('nameSet').value = S.name;
  $('sounds').checked = S.sounds;
  document.querySelectorAll('.swatch').forEach(b => b.classList.toggle('sel', b.dataset.c === S.color));
  $('testBtn').textContent = testEl ? '⏹️ Arrêter le test' : '🎧 Tester mon micro';
  renderPanel();
}
function updateMeter(lvl) {
  const pct = d => Math.max(0, Math.min(100, d + 100));
  const th = threshold();
  $('meterFill').style.width = pct(lvl) + '%';
  $('meterFill').classList.toggle('pass', S.mode === 'ptt' ? mic.open : lvl > th);
  $('meterMark').style.left = `calc(${pct(th)}% - 1px)`;
  $('vadVal').textContent = S.vadAuto ? '(auto)' : `${S.vadThreshold} dB`;
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const ds = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, cur) => {
    const list = ds.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    sel.innerHTML = '<option value="">Par défaut</option>' + list.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Périphérique ' + (i + 1))}</option>`).join('');
    sel.value = list.some(d => d.deviceId === cur) ? cur : '';
  };
  fill($('inputSel'), 'audioinput', S.inputId);
  fill($('outputSel'), 'audiooutput', S.outputId);
  $('permBtn').classList.toggle('hidden', ds.some(d => d.kind === 'audioinput' && d.label));
}
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
$('permBtn').onclick = () => openMic().then(() => { state.micOk = true; syncVoice(); }).catch(() => toast('🎙️ Micro refusé : autorise-le dans le navigateur.'));

const reopenMic = () => { if (mic.raw) openMic().then(syncVoice).catch(() => tryOpenMic()); };
$('inputSel').onchange = () => { S.inputId = $('inputSel').value; save(); reopenMic(); };
$('outputSel').onchange = () => { S.outputId = $('outputSel').value; save(); applySinks(); };
$('inVol').oninput = () => { S.inputVol = +$('inVol').value; save(); applyInputVol(); renderSettings(); };
$('outVol').oninput = () => { S.outputVol = +$('outVol').value; save(); applyOutputs(); renderSettings(); };
document.querySelectorAll('input[name=mode]').forEach(r => r.onchange = () => { S.mode = r.value; save(); renderSettings(); });
$('vadAuto').onchange = () => { S.vadAuto = $('vadAuto').checked; save(); renderSettings(); };
$('vadSlider').oninput = () => { S.vadThreshold = +$('vadSlider').value; save(); };
$('pttKeyBtn').onclick = () => { capturingKey = true; renderSettings(); };
$('pttDelay').oninput = () => { S.pttDelay = +$('pttDelay').value; save(); renderSettings(); };
['noise', 'echo', 'agc'].forEach(k => $(k).onchange = () => { S[k] = $(k).checked; save(); reopenMic(); });
$('voiceBitrate').onchange = () => {
  S.voiceKbps = +$('voiceBitrate').value; save();
  for (const f of friends.values()) { if (f.voiceOut?.peerConnection) tuneAudio(f.voiceOut.peerConnection); }
};
const setQuality = v => { S.quality = v; save(); renderSettings(); };
$('qualitySel').onchange = () => setQuality($('qualitySel').value);
$('quality').onchange = () => setQuality($('quality').value);
$('hintSel').onchange = () => { S.hint = $('hintSel').value; save(); };
$('screenAudio').onchange = () => { S.screenAudio = $('screenAudio').checked; save(); };
$('showStats').onchange = () => { S.showStats = $('showStats').checked; save(); if (screenOwner) $('stats').classList.toggle('hidden', !S.showStats); };
$('sounds').onchange = () => { S.sounds = $('sounds').checked; save(); };
const setName = v => {
  S.name = v.slice(0, 20); save();
  $('name').value = $('nameSet').value = S.name;
  broadcast({ type: 'state', ...myState() }); renderPeople(); renderPanel();
};
$('nameSet').oninput = () => setName($('nameSet').value);
$('name').oninput = () => { S.name = $('name').value; save(); };
$('colors').onclick = e => {
  const c = e.target.dataset?.c; if (!c) return;
  S.color = c; save(); renderSettings(); broadcast({ type: 'state', ...myState() }); renderPeople();
};

// Test du micro : on s'écoute après la porte (comme les autres nous entendent)
function stopTest() { testEl?.remove(); testEl = null; }
$('testBtn').onclick = async () => {
  ensureCtx();
  if (testEl) { stopTest(); return renderSettings(); }
  if (!mic.raw) { await tryOpenMic(); if (!mic.raw) return; }
  if (state.muted || state.deafened) toast('Ton micro est coupé ou en sourdine : réactive-le pour t\'entendre.');
  testEl = document.createElement('audio');
  testEl.autoplay = true; testEl.srcObject = new MediaStream([mic.track]);
  $('audios').appendChild(testEl);
  applySink(testEl); applyOutputs();
  testEl.play().catch(() => {});
  renderSettings();
};

// ================= Plein écran (iPad / iPhone / ordinateur) =================
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function setFake(on) {
  $('stage').classList.toggle('fake-fs', on);
  document.body.classList.toggle('fs-lock', on);
  $('fsBtn').textContent = on ? '✕ Quitter' : '⛶ Plein écran';
}
$('fsBtn').onclick = async () => {
  const st = $('stage'), v = $('remoteVideo');
  if (st.classList.contains('fake-fs')) return setFake(false);
  if (fsElement()) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  try {
    if (st.requestFullscreen) return await st.requestFullscreen();
    if (st.webkitRequestFullscreen) return st.webkitRequestFullscreen(); // iPad Safari
  } catch (e) {}
  if (v.webkitEnterFullscreen) { try { return v.webkitEnterFullscreen(); } catch (e) {} } // iPhone
  setFake(true);
};
const onFsChange = () => $('fsBtn').textContent = fsElement() ? '✕ Quitter' : '⛶ Plein écran';
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

// ================= Démarrage =================
$('name').value = S.name;
renderSettings();
// Lien partagé (…#CODE) : on pré-remplit, il reste à cliquer « Rejoindre » (geste requis pour le son sur iPad)
if (location.hash.length > 1) {
  $('code').value = cleanCode(location.hash);
  status('Choisis un pseudo puis clique sur « Rejoindre ».', 'ok');
}
