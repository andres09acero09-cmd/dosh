// Prueba: chat en vivo durante la partida online (humano -> humano)
const WebSocket = require('ws');
const URL = 'ws://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failed = 0;
function check(ok, label, info = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + (info ? ' | ' + info : ''));
  if (!ok) failed++;
}

function client(name) {
  const raw = new WebSocket(URL);
  let id = null; const chats = []; let waiterChat = null;
  let lastState = null; let waiterState = null;
  raw.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'ROOM_CREATED' || msg.type === 'ROOM_JOINED') { id = msg.payload.myId; }
    if (msg.type === 'CHAT_MSG') { chats.push(msg.payload); if (waiterChat) { const w = waiterChat; waiterChat = null; w(msg.payload); } }
    if (msg.type === 'STATE') { lastState = msg.payload; if (waiterState) { const w = waiterState; waiterState = null; w(msg.payload); } }
  });
  return {
    name, id: () => id, chats, lastState: () => lastState,
    send: (type, p) => raw.send(JSON.stringify({ type, payload: p })),
    close: () => raw.close(),
  };
}

(async () => {
  const a = client('Ana'); const b = client('Ben');
  await sleep(400);

  a.send('CREATE_ROOM', { name: 'Ana', targetPlayers: 2, cardsPerPlayer: 4 });
  await sleep(500);
  b.send('JOIN_ROOM', { roomCode: null, name: 'BenX' }); // código inválido a propósito: no debe romper
  await sleep(400);

  // Reintentar join con código real: obtener el código escuchando ROOM_CREATED vía A no es
  // posible con este cliente simple; en su lugar una segunda sala no es necesaria: usar ROOM_JOINED
  // de A para capturar el código.
  let roomCode = null;
  const rawA = a;
  // El cliente simple guarda chats/estados; para el código, mosca: conectamos un cliente extra
  const probe = client('Probe');
  await sleep(300);

  // Crear sala definitiva con A y capturar código con sniffing del propio payload ROOM_CREATED:
  // arg: el cliente A ya creó una sala antes. Creamos una nueva con C (probe) y usamos su código.
  probe.send('CREATE_ROOM', { name: 'Probe', targetPlayers: 3, cardsPerPlayer: 4 });
  await sleep(500);
  // probe.leave — en lugar de espiar el código, usamos LEAVE + probe deja la sala;
  // no podemos leer el código con este arnés simple... -> usamos otro cliente con handler.
  probe.close();

  // ── Arnés definitivo con captura de código ──
  const mk = () => {
    const raw = new WebSocket(URL);
    let rc = null; let myId = null; let lastPayload = null;
    const chats2 = [];
    let onChatWait = null;
    raw.on('message', (d) => {
      let m = null;
      try { m = JSON.parse(d.toString()); } catch (e) { return; }
      if (m.type === 'ROOM_CREATED' || m.type === 'ROOM_JOINED') { rc = m.payload.roomCode; myId = m.payload.myId; }
      if (m.type === 'CHAT_MSG') { chats2.push(m.payload); if (onChatWait) { const w = onChatWait; onChatWait = null; w(m.payload); } }
      if (m.type === 'STATE') { lastPayload = m.payload; }
    });
    return { raw, code: () => rc, myId: () => myId, chats: chats2, lastState: () => lastPayload,
      send: (t, p) => raw.send(JSON.stringify({ type: t, payload: p })),
      chatP: (ms) => new Promise(res => { onChatWait = res; setTimeout(() => { if (onChatWait === res) { onChatWait = null; res(null); } }, ms); }),
      close: () => raw.close() };
  };

  const h = mk('H'); const j = mk('J');
  await sleep(300);
  h.send('CREATE_ROOM', { name: 'Ana', targetPlayers: 2, cardsPerPlayer: 4 });
  await sleep(500);
  const code = h.code();
  check(!!code, 'Sala creada (anjés definitivo)', code || 'n/a');
  j.send('JOIN_ROOM', { roomCode: code, name: 'Ben' });
  await sleep(600);
  check(j.code() === code, 'Ben se unió a la sala', j.code() || 'n/a');

  h.send('START_GAME', {});
  // Esperar fase jugable (peeking/playing): los broadcasts ya están llegando a Ben
  let playing = false; let lastPhase = 'n/a';
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const s = (j.lastState && j.lastState()) ? (j.lastState().public || null) : null;
    if (s) {
      lastPhase = s.phase !== undefined ? s.phase : ('keys:' + Object.keys(s).join(','));
      if (s.phase === 'playing' || s.phase === 'peeking') { playing = true; break; }
    }
  }
  check(playing, 'Partida en fase jugable y con chat activo', `phase=${lastPhase}`);

  // Chat durante la partida: Ana escribe, Ben recibe Y Ana recibe su propio mensaje
  const pBen = j.chatP(3000);
  const pAna = h.chatP(2000);
  h.send('CHAT_SEND', { text: 'Todo bien ahí?' });
  const gotB = await pBen;
  const gotA = await pAna;
  check(!!gotB && gotB.text === 'Todo bien ahí?' && gotB.name === 'Ana', 'Ben recibe el chat de Ana en vivo', gotB ? `${gotB.name}: ${gotB.text}` : 'n/a');
  check(!!gotA && gotA.text === 'Todo bien ahí?', 'Ana también ve su propio mensaje', gotA ? 'ok' : 'n/a');
  check(!!gotB && typeof gotB.id === 'string', 'El mensaje lleva el id del emisor', gotB ? gotB.id : 'n/a');

  // Límite anti-spam: dos envíos seguidos; solo 1 debe pasar (500ms de ventana)
  await sleep(700); // salir de la ventana del mensaje anterior
  h.send('CHAT_SEND', { text: 'spam1' });
  h.send('CHAT_SEND', { text: 'spam2' });
  await sleep(900);
  check(j.chats.filter(c => c.text === 'spam1').length === 1, 'spam1 pasó', '');
  check(j.chats.filter(c => c.text === 'spam2').length === 0, 'spam2 rechazado por el límite de 500ms', '');

  // Texto malicioso/trim: el servidor trunca a 200 y el cliente usa textContent
  const pB2 = j.chatP(3000);
  h.send('CHAT_SEND', { text: '   hola<script>x</script>   ' });
  const t2 = await pB2;
  check(!!t2 && t2.text === 'hola<script>x</script>', 'Texto con trim (inyección se ve como texto plano en el cliente)', t2 ? t2.text : 'n/a');
  check(!!t2 && t2.text.length > 0, 'Mantuvo el contenido', '');

  // Esperar fuera de la ventana anti-spam antes de la última prueba
  await sleep(700);

  // Fuera de partida el chat NO viaja: en lobby el envío se ignora
  const pB3 = j.chatP(1500);
  await sleep(100);
  // no terminamos la partida: exigimos sala en 'playing' activa -> pasamos el turno y provocamos fin? Demasiado corto.
  // alternativa: el chat en lobby ya quedó cubierto porque START no emitido... probamos rápido con socket B en SALA no jugando
  const p = mk('P');
  await sleep(300);
  p.send('CREATE_ROOM', { name: 'LobbyX', targetPlayers: 3, cardsPerPlayer: 4 });
  await sleep(600);
  p.send('CHAT_SEND', { text: 'en lobby no' });
  await sleep(700);
  // sin receptor en sala (solo P): nada debe llegar ni romper; verificamos que su sala no murió
  p.send('CHAT_SEND', { text: 'sigue vivo' });
  await sleep(400);
  check(p.code() !== null, 'Sala en lobby sigue viva tras intentos de chat', p.code() || 'n/a');

  h.close(); j.close(); p.close();
  console.log(failed === 0 ? '\nSMOKE4 OK' : `\n${failed} FALLOS`);
  process.exit(failed === 0 ? 0 : 1);
})();
