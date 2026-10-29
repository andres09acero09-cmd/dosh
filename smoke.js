// Prueba de humo rápida del contrato clave del servidor (versión GitHub)
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
  const states = [];
  let lastNonState = null;
  let waiter = null;
  raw.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'ROOM_CREATED' || msg.type === 'ROOM_JOINED') { id = msg.payload.myId; payload = msg.payload; lastNonState = msg; }
    else if (msg.type === 'STATE') { states.push(msg.payload); }
    else { lastNonState = msg; }
    if (waiter) { const w = waiter; waiter = null; w(msg); }
  });
  return {
    name, id: () => id, payload: () => payload, states,
    send: (type, payload2) => raw.send(JSON.stringify({ type, payload: payload2 })),
    next: (pred) => new Promise(r => { waiter = r; }),
    state: () => states[states.length - 1] || null,
    close: () => raw.close(),
  };
}

(async () => {
  const host = client('Host');
  const p2 = client('P2');
  await sleep(400);

  host.send('CREATE_ROOM', { name: 'Host', targetPlayers: 2, cardsPerPlayer: 4 });
  await sleep(400);
  const code = host.payload().roomCode;
  const hostId = host.id();
  check(!!hostId && !!code, 'Room creada: id/host y código recibidos', String(code));

  p2.send('JOIN_ROOM', { roomCode: code, name: 'P2' });
  await sleep(400);
  check(!!p2.id(), 'P2 se unió a la sala');

  host.send('START_GAME', {});
  await sleep(300);

  // Fase peek: host + p2 revelan 2 cartas cada uno y listos
  host.send('GAME_ACTION', { action: 'PEEK_REVEAL', slotIndex: 0, turnId: 0 });
  host.send('GAME_ACTION', { action: 'PEEK_REVEAL', slotIndex: 2, turnId: 0 });
  p2.send('GAME_ACTION', { action: 'PEEK_REVEAL', slotIndex: 0, turnId: 0 });
  p2.send('GAME_ACTION', { action: 'PEEK_REVEAL', slotIndex: 2, turnId: 0 });
  await sleep(400);
  host.send('GAME_ACTION', { action: 'PEEK_DONE', turnId: 0 });
  p2.send('GAME_ACTION', { action: 'PEEK_DONE', turnId: 0 });

  // esperar fase playing
  let s = null;
  for (let i = 0; i < 40; i++) {
    s = host.state();
    if (s && s.public.phase === 'playing') break;
    await sleep(250);
  }
  check(s && s.public.phase === 'playing', 'Fase playing alcanzada', s && s.public.phase);

  // DRAW del host (host = jugador 0)
  let tid = s.public.turnId;
  host.send('GAME_ACTION', { action: 'DRAW', turnId: tid });
  await sleep(500);
  s = host.state();
  check(!!s.public.drawnCard, 'drawnCard es PÚBLICA (todos la ven)', s.public.drawnCard ? s.public.drawnCard.rank + s.public.drawnCard.suit : 'null');
  check(typeof s.public.jPowerUsable === 'boolean', 'jPowerUsable viaja en el estado', String(s.public.jPowerUsable));

  // REPLACE (cambiarla): host reemplaza slot 0 → fx.land presente con carta pública
  tid = s.public.turnId;
  host.send('GAME_ACTION', { action: 'REPLACE', slotIndex: 0, turnId: tid });
  await sleep(500);
  s = host.state();
  check(!!(s.public.fx && s.public.fx.land), 'fx.land presente tras REPLACE', JSON.stringify(s.public.fx || null));
  check(!!s.public.activeTableCard, 'La carta botada quedó en la mesa como activa', s.public.activeTableCard ? s.public.activeTableCard.rank + s.public.activeTableCard.suit : 'null');

  // Sin fugas: la vista pública NO incluye manos mientras juega
  const p = s.public.players[0];
  check(p.hand === null || p.hand === undefined, 'Sin manos en la vista pública durante partida');

  // ── DOSH: aviso + pausa de 30s (turno NO se consume con la pantallaza) ──
  tid = s.public.turnId;
  // Dejamos la carta en la mesa para despejar el estado (sin carta activa)
  host.send('GAME_ACTION', { action: 'DISCARD', turnId: tid });
  await sleep(400);
  s = host.state();

  // P2 (jugador siguiente) canta DOSH durante su turno
  const p2Idx = s.public.currentPlayerIndex;
  tid = s.public.turnId;
  p2.send('GAME_ACTION', { action: 'ANNOUNCE_DOSH', turnId: tid });
  await sleep(500);
  s = p2.state();
  const noticeDosh = s.public.notice ? s.public.notice.text : '';
  check(/CANTÓ DOSH/.test(noticeDosh), 'Aviso público del canto de DOSH llega por notice', noticeDosh);
  check(s.public.doshAnnouncedBy === p2Idx, 'doshAnnouncedBy es el cantador');
  // La cuenta NO empezó consumida: cada player recibe 30s restantes aunque la pantallaza esté activa
  check(s.public.turnSecondsLeft >= 29, 'Los 30s del turno NO se consumen con la pantallaza (pausa)', String(s.public.turnSecondsLeft));

  // Tras 3.2s sigue el mismo turno (DOSH NO pasa el turno)
  await sleep(3200);
  s = p2.state();
  check(s.public.currentPlayerIndex === p2Idx, 'El cantador conserva su turno tras la pantallaza', `idx=${s.public.currentPlayerIndex}`);

  console.log(failed === 0 ? '\nHUMO OK ✔' : `\n${failed} FALLOS ✘`);
  host.close(); p2.close();
  process.exit(failed === 0 ? 0 : 1);
})();
