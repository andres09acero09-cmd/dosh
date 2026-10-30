// Prueba: al fallar la copia la carta se ve boca arriba y luego se re-oculta sola
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
  let id = null; let code = null;
  const states = []; const knownCards = {};
  let waiter = null;
  raw.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'ROOM_CREATED' || msg.type === 'ROOM_JOINED') { id = msg.payload.myId; code = msg.payload.roomCode; }
    if (msg.type === 'PEEK_REVEALED') knownCards[msg.payload.slotIndex] = msg.payload.card;
    if (msg.type === 'STATE') { states.push(msg.payload); if (waiter) { const w = waiter; waiter = null; w(msg.payload); } }
  });
  return {
    name, id: () => id, code: () => code, knownCards, states,
    send: (type, p) => raw.send(JSON.stringify({ type, payload: p })),
    state: () => states[states.length - 1] || null,
    priv: () => { const s = states[states.length - 1]; return s ? s.private : null; },
    close: () => raw.close(),
  };
}

(async () => {
  const h = client('Humano');
  await sleep(400);
  h.send('CREATE_ROOM', { name: 'Humano', targetPlayers: 2, cardsPerPlayer: 4 });
  await sleep(500);
  h.send('START_GAME', {});
  await sleep(900);
  h.send('GAME_ACTION', { action: 'PEEK_REVEAL', slotIndex: 0, turnId: 0 });
  h.send('GAME_ACTION', { action: 'PEEK_REVEAL', slotIndex: 2, turnId: 0 });
  await sleep(300);
  h.send('GAME_ACTION', { action: 'PEEK_DONE', turnId: 0 });

  // Fase playing
  for (let i = 0; i < 60; i++) {
    const s = h.state();
    if (s && s.public.phase === 'playing') break;
    await sleep(250);
  }

  let failSeen = false;
  let revealedIdx = -1;
  const deadline = Date.now() + 90000;

  while (!failSeen && Date.now() < deadline) {
    let s = h.state();
    if (!s || s.public.phase !== 'playing' && s.public.phase !== 'dosh') { await sleep(300); continue; }
    // Solo actuamos cuando es nuestro turno y NO hay carta activa
    if (s.public.currentPlayerIndex !== 0 || s.public.hasDrawnCard || s.public.activeTableCard) { await sleep(400); continue; }
    if (!s.public.turnId && s.public.turnId !== 0) { await sleep(300); continue; }

    const tid = s.public.turnId;
    h.send('GAME_ACTION', { action: 'DRAW', turnId: tid });
    for (let i = 0; i < 12; i++) { await sleep(250); s = h.state(); if (h.priv() && h.priv().myDrawnCard) break; }
    const drawn = h.priv() ? h.priv().myDrawnCard : null;
    if (!drawn) { await sleep(800); continue; }

    const k0 = h.knownCards[0];
    const knowMatch0 = k0 && k0.rank === drawn.rank && (drawn.rank !== 'K' || k0.color === drawn.color);

    if (knowMatch0) {
      // Iguales con slot conocido: pasamos el turno y reintentamos en la próxima vuelta
      h.send('GAME_ACTION', { action: 'PASS_TURN', turnId: s.public.turnId });
      await sleep(600);
      continue;
    }

    // slot0 no coincide garantizado → MATCH fallido
    h.send('GAME_ACTION', { action: 'MATCH', slotIndex: 0, turnId: s.public.turnId });

    // Esperar estado con la carta revelada (faceUp) en CUALQUIER slot de mi mano
    // (la penalización ">+1" se inserta al inicio de la mano y mueve los índices)
    let revealedState = null;
    let revealedIdx = -1;
    for (let i = 0; i < 12; i++) {
      await sleep(300);
      const priv = h.priv();
      if (priv && priv.myHand) {
        priv.myHand.forEach((sl, idx) => {
          if (sl.faceUp && sl.card && revealedState === null) { revealedState = sl; revealedIdx = idx; }
        });
      }
      if (revealedState) break;
    }
    if (!revealedState) {
      // quizá el MATCH falló por stale u otra razón; reintentar
      continue;
    }
    failSeen = true;
    check(revealedState.faceUp && !!revealedState.card, 'Al fallar la copia, MI carta elegida se ve boca arriba',
      revealedState.card.rank + revealedState.card.suit);
    check(revealedState.known === true, 'El servidor la marca como conocida');
  }

  check(failSeen, 'Se produjo el fallo de copia en el arnés', '');

  if (failSeen) {
    // Esperar el auto-ocultado (~3.5s en servidor). Robusto a inserciones de penalización:
    // ninguna carta propia debe seguir boca arriba (se volvió a ocultar sola).
    await sleep(4200);
    let anyFaceUp = null; let knownCount = 0;
    for (let i = 0; i < 3; i++) {
      const priv = h.priv();
      const hand = priv && priv.myHand ? priv.myHand : null;
      if (hand) {
        anyFaceUp = hand.some(s2 => s2.faceUp);
        knownCount = hand.filter(s2 => s2.known && s2.card).length;
        break;
      }
      await sleep(400);
    }
    check(anyFaceUp === false, 'Después de unos segundos toda mi baraja vuelve a estar boca abajo', `faceUp restante=${anyFaceUp}`);
    check(knownCount >= 2, 'Sigo recordando las cartas vistas (conocida sin estar boca abajo)',
      `conocidas=${knownCount} (los bots pueden intercambiarme cartas con la J y eso re-oculta las suyas)`);
  }

  h.close();
  console.log(failed === 0 ? '\nSMOKE3 OK' : `\n${failed} FALLOS`);
  process.exit(failed === 0 ? 0 : 1);
})();
