// Prueba de humo 2: doble baraja, fallos del bot con la mesa y carta revelada al fallar
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
  let id = null; let payload = null;
  let code = null;
  const states = [];
  let waiter = null;
  raw.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'ROOM_CREATED' || msg.type === 'ROOM_JOINED') { id = msg.payload.myId; payload = msg.payload; code = msg.payload.roomCode; }
    else if (msg.type === 'STATE') { states.push(msg.payload); }
    if (waiter) { const w = waiter; waiter = null; w(msg); }
  });
  return {
    name, id: () => id, payload: () => payload, code: () => code, states,
    send: (type, p) => raw.send(JSON.stringify({ type, payload: p })),
    next: () => new Promise(r => { waiter = r; }),
    state: () => states[states.length - 1] || null,
    close: () => raw.close(),
  };
}

(async () => {
  const host = client('Host');
  await sleep(400);

  // Creo sala de 3 (el host entra; los otros 2 son bots) — la partida sale con doble baraja
  host.send('CREATE_ROOM', { name: 'Humano', targetPlayers: 3, cardsPerPlayer: 4 });
  await sleep(500);
  host.send('START_GAME', {});
  await sleep(800);

  // Pase la fase peek (revelar 2 cartas + listo/bots auto)
  for (let i = 0; i < 2; i++) host.send('GAME_ACTION', { action: 'PEEK_REVEAL', slotIndex: i === 0 ? 0 : 2, turnId: 0 });
  await sleep(200);
  host.send('GAME_ACTION', { action: 'PEEK_DONE', turnId: 0 });

  let s = null;
  for (let i = 0; i < 40; i++) {
    s = host.state();
    if (s && s.public.phase === 'playing') break;
    await sleep(250);
  }
  check(s && s.public.phase === 'playing', 'Fase playing alcanzada', s && s.public.phase);
  check(s.public.deckCount > 80, 'Mazo GRANDE (doble baraja ≈ 100 cartas tras repartir 12)', String(s.public.deckCount));

  // Esperar a que a un BOT le toque jugar con una carta en mesa y FALLA 3 veces → pasa el turno.
  // Detectamos: un bot hace matchWithTable fallido 3 veces seguidas sin cambiar de turno
  // → luego currentPlayerIndex cambia con aviso "falló la copia 3 veces".
  const t0 = Date.now();
  let sawLimit = false;
  let lastNotice = '';
  while (Date.now() - t0 < 60000) {
    s = host.state();
    if (!s || !s.public) { await sleep(300); continue; }
    const n = s.public.notice ? s.public.notice.text : '';
    if (n.includes('falló la copia 3 veces')) { sawLimit = true; break; }
    if (s.public.phase === 'ended') break;
    await sleep(500);
  }
  check(sawLimit, 'Límite anti-bucle: aviso "falló la copia 3 veces" aparece',
    host.state() && host.state().public.notice ? host.state().public.notice.text : '(no visto)');

  host.close();
  process.exit(failed === 0 ? 0 : 1);
})();
