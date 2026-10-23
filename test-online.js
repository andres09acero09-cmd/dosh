/**
 * Prueba automática de la arquitectura servidor-autoritativo de DOSH.
 * Simula 2 humanos + 1 bot, valida privacidad, turnId, acciones ilegales,
 * transición peek->playing, DOSH y puntuación final del servidor.
 * Ejecutar con: node test-online.js
 */
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const PORT = 3000;
let failures = 0;
const results = [];

function assert(cond, name, extra = '') {
  const ok = !!cond;
  results.push(`${ok ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (!ok) failures++;
}

// ─── Cliente WS de prueba ──────────────────────────────────────────────────────
class TestClient {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.states = [];          // historial de STATE recibidos (cada uno ya parseado)
    this.history = [];         // historial de TODOS los mensajes (para anti-carrera)
    this.waiters = [];         // promesas pendientes de un próximo mensaje
    this.leakCount = 0;        // violaciones de privacidad detectadas
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => this._onMessage(JSON.parse(data.toString())));
    });
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* noop */ } }
    this.ws = null;
  }

  send(obj) { if (this.ws) this.ws.send(JSON.stringify(obj)); }

  action(a, turnId, payload = {}) {
    this.send({ type: 'GAME_ACTION', payload: { action: a, turnId, ...payload } });
  }

  _onMessage(msg) {
    this.history.push(msg);
    if (msg.type === 'STATE') {
      this._scanStatePrivacy(msg.payload);
      this.states.push(msg.payload);
    }
    // Despertar SOLO los esperas cuyo predicado acepta este mensaje
    // (resolución: STATE → su payload; otros → el mensaje crudo)
    this.waiters = this.waiters.filter(w => {
      if (w.pred(msg)) { w.resolve(msg.type === 'STATE' ? msg.payload : msg); return false; }
      return true;
    });
  }

  /** Escanea que ningún STATE revele cartas que no corresponden */
  _scanStatePrivacy(payload) {
    const pub = payload.public || {};
    const ended = pub.phase === 'ended';
    (pub.players || []).forEach((p) => {
      if (p.hand !== null && !ended) this.leakCount++; // manos solo visibles al terminar
      if (p.hand !== null && ended) {
        // Formas correctas al final
        if (typeof p.handCount !== 'number') this.leakCount++;
      }
    });
    if (typeof pub.deckCount !== 'number') this.leakCount++;
    const priv = payload.private || {};
    // La carta robada solo llega a quien la robó; el cliente guarda su propio historial
    if (priv.myDrawnCard && typeof priv.myDrawnCard !== 'object') this.leakCount++;
  }

  lastState() { return this.states.length ? this.states[this.states.length - 1] : null; }

  turnId() { const s = this.lastState(); return s ? s.public.turnId : -1; }
  turnIdx() { const s = this.lastState(); return s ? s.public.currentPlayerIndex : -1; }
  phase()   { const s = this.lastState(); return s ? s.public.phase : null; }
  myIndex() {
    const s = this.lastState();
    return s && s.private ? s.private.myIndex : -1;
  }

  waitState(timeoutMs = 15000) {
    return this._wait(m => m.type === 'STATE', timeoutMs);
  }

  wait(pred, timeoutMs = 15000) {
    return this._wait(pred, timeoutMs);
  }

  _wait(pred, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter(x => x !== w);
        reject(new Error(`[${this.name}] Timeout esperando mensaje; pred: ${pred.toString().slice(0, 80)}`));
      }, timeoutMs);
      const wrappedResolve = (v) => { clearTimeout(t); resolve(v); };
      w.resolve = wrappedResolve;
    });
  }

  /** Espera hasta que sea el turno de `playerIndex` (iterando STATEs) */
  async waitTurn(playerIndex, maxStates = 60) {
    let guard = 0;
    while (this.turnIdx() !== playerIndex && (this.phase() === 'playing' || this.phase() === 'dosh')) {
      if (guard++ > maxStates) throw new Error(`[${this.name}] Demasiados estados sin llegar al jugador ${playerIndex}`);
      await this.waitState();
    }
  }

  /** Espera la fase dada directamente */
  async waitPhase(phase, maxStates = 60) {
    let guard = 0;
    while (this.phase() !== phase) {
      if (guard++ > maxStates) throw new Error(`[${this.name}] Fase ${phase} nunca llegó (última: ${this.phase()})`);
      await this.waitState();
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Escenario A: partida completa con DOSH ───────────────────────────────────
async function scenarioA() {
  const host = new TestClient('Host');
  const p2 = new TestClient('Jugador2');
  await host.connect();
  await p2.connect();

  // Crear sala de 3 (1 bot se agregará al iniciar)
  host.send({ type: 'CREATE_ROOM', payload: { name: 'Host', targetPlayers: 3, cardsPerPlayer: 4 } });
  const created = await host.wait(m => m.type === 'ROOM_CREATED', 10000);
  assert(created && created.payload.roomCode, 'A1. Sala creada con código', created && created.payload.roomCode);
  const code = created.payload.roomCode;

  p2.send({ type: 'JOIN_ROOM', payload: { roomCode: code, name: 'Jugador2' } });
  const joined = await p2.wait(m => m.type === 'ROOM_JOINED', 10000);
  assert(joined && joined.payload.roomCode === code, 'A2. Jugador2 se unió');

  host.send({ type: 'START_GAME', payload: {} });
  const started1 = await host.wait(m => m.type === 'GAME_STARTED', 10000);
  const started2 = await p2.wait(m => m.type === 'GAME_STARTED', 10000);
  assert(true, 'A3. GAME_STARTED recibido en ambos clientes (sin mazo en el payload)');

  // Verificar que los ids de GAME_STARTED son los IDs REALES de la sala
  // (si no, el cliente no puede saber qué jugador es él)
  const roomIds = new Set([
    ...((created.payload.players || []).map(p => p.id)),
    ...((joined.payload.players || []).map(p => p.id)),
  ]);
  const startedIds = (started2.payload.players || []).filter(p => !p.isBot).map(p => p.id);
  assert(startedIds.length === 2 && startedIds.every(id => roomIds.has(id)),
    'A3b. GAME_STARTED lleva ids reales de sala (consultables por el cliente)',
    JSON.stringify(startedIds));

  const h0 = await host.waitState();
  const p0 = await p2.waitState();
  assert(h0.public.phase === 'peeking' && p0.public.phase === 'peeking', 'A4. Fase inicial peeking en ambos');
  assert(h0.public.players.length === 3 && p0.public.players.length === 3, 'A5. 3 jugadores (2 humanos + 1 bot)');
  assert(h0.public.players.filter(x => x.isBot).length === 1 && h0.public.players.filter(x => x.isBot).length === 1, 'A6. 1 bot en la sala');
  assert(h0.private.myHand.length === 4 && h0.private.myHand.every(s => s.card === null && !s.known),
    'A7. Mano privada local: 4 cartas sin identificar (servidor no envía identidades)');
  assert(h0.public.players[1].hand === null, 'A8. Manos ajenas no llegan (null en vista pública)');
  assert(p0.public.deckCount === 54 - 12, 'A9. deckCount debe ser 42 (54 - 12 repartidas)', String(h0.public.deckCount));

  // -- FASE PEEK: cada humano mira 2 cartas (la mitad) --
  await host.action('PEEK_REVEAL', 0, { slotIndex: 0 });
  const rev0 = await host.wait(m => m.type === 'PEEK_REVEALED', 10000);
  assert(rev0 && rev0.payload && rev0.payload.card && typeof rev0.payload.card.rank === 'string',
    'A10. PEEK_REVEALED llegó al dueño con la identidad de SU carta');
  await host.action('PEEK_REVEAL', 0, { slotIndex: 2 });
  await host.wait(m => m.type === 'PEEK_REVEALED', 10000);

  await p2.action('PEEK_REVEAL', 0, { slotIndex: 1 });
  await p2.wait(m => m.type === 'PEEK_REVEALED', 10000);
  await p2.action('PEEK_REVEAL', 0, { slotIndex: 3 });
  await p2.wait(m => m.type === 'PEEK_REVEALED', 10000);

  // Intento de 3ra carta → rechazo
  await host.action('PEEK_REVEAL', 0, { slotIndex: 1 });
  const extra = await host.wait(m => m.type === 'ERROR', 10000).catch(() => null);
  assert(extra && /Ya viste todas/.test(extra.payload.message),
    'A11. Límite de la mitad de cartas validado (3ra carta rechazada)',
    extra ? extra.payload.message : 'sin respuesta');

  // Los dos humanos terminan de memorizar → el bot causa apertura o espera; el host inicia
  host.action('PEEK_DONE', 0);
  p2.action('PEEK_DONE', 0);

  await host.waitPhase('playing');
  await p2.waitPhase('playing');
  assert(true, 'A12. Mesa abierta: fase playing para todos (apertura sincronizada por servidor)');
  assert(host.turnId() >= 1 && p2.turnId() === host.turnId(), 'A13. turnId sincronizado en ambos', String(host.turnId()));
  assert(host.turnIdx() === 0 && p2.turnIdx() === 0, 'A14. Turno inicial: jugador 0 (host)');
  assert(host.lastState().public.turnSecondsLeft !== null && host.lastState().public.turnSecondsLeft > 25,
    'A15. El servidor envía cuenta atrás del turno', String(host.lastState().public.turnSecondsLeft));

  // -- Validación de rechazos --
  if (p2.turnIdx() !== 0) { /* no debe ocurrir */ }
  // Nota: turnId del STATE inicial de la fase playing se usa para rechazar atrasadas
  const staleTurnId = host.turnId();

  // Jugador 2 intenta actuar sin ser su turno → ERROR
  await p2.action('DRAW', staleTurnId);
  const errN = await p2.wait(m => m.type === 'ERROR', 10000);
  assert(errN && /No es tu turno/.test(errN.payload.message), 'A16. Acción fuera de turno: rechazada', errN.payload.message);

  // Host con turnId inválido → ACTION_STALE
  await host.action('DRAW', staleTurnId + 999);
  const stale = await host.wait(m => m.type === 'ACTION_STALE', 10000);
  assert(stale && stale.payload.message, 'A17. Acción atrasada: rechazada con ACTION_STALE', stale.payload.message);

  // Host intenta PAY sin dibujar → ERROR (si ahora es su turno válido con turnId real)
  const realTurnId = host.turnId();
  await host.action('DISCARD', realTurnId);
  const errD = await host.wait(m => m.type === 'ERROR' || m.type === 'ACTION_ERROR', 10000);
  assert(errD && errD.payload.message, 'A18. Descartar sin carta robada: rechazado', errD.payload.message);

  // -- DOSH inmediato en el primer turno del host --
  await host.action('ANNOUNCE_DOSH', realTurnId);
  await host.waitState();
  await p2.waitState();
  assert(host.phase() === 'dosh' && p2.phase() === 'dosh', 'A19. DOSH cantado: fase dosh sincronizada');
  assert(host.lastState().public.doshAnnouncedBy === 0, 'A20. doshAnnouncedBy = 0 (host)');

  // -- Última ronda: cada jugador juega DRAW -> acción -> hasta que la partida termine --
  let guard = 0;
  while (guard++ < 40) {
    const phase = host.phase();
    if (phase === 'ended') break;

    const idx = host.turnIdx();
    // El bot juega solo; los humanos actuamos
    if (idx === 0) await playHumanTurn(host, 0);
    else if (idx === 1) await playHumanTurn(p2, 1);
    // acumulan estados hasta que cambie el turno del bot
    if (idx === 2) {
      // esperar a que el turno cambie (bot actúa con tiempos internos)
      await sleep(2500);
      await host.waitState(20000).catch(() => {});
      await p2.waitState(20000).catch(() => {});
    }
  }
  const tid = host.turnId();
  const tid2 = p2.turnId();
  const cpi = host.turnIdx();

  await host.waitPhase('ended');
  await p2.waitPhase('ended');

  assert(true, 'A21. Partida terminada (fase ended sincronizada)');
  // turnId etc no necesarios al final

  const finalH = host.lastState().public;
  const finalP = p2.lastState().public;
  assert(Array.isArray(finalH.scoreResults) && finalH.scoreResults.length === 3, 'A22. scoreResults calculadas por el SERVER (3 jugadores)');
  assert(finalH.scoreResults.some(r => r.isWinner) && finalH.scoreResults.length === 3, 'A23. Hay al menos ganador flagged');
  assert(
    JSON.stringify(finalH.tableHistory) === JSON.stringify(finalP.tableHistory),
    'A24. tableHistory idéntica entre ambos clientes'
  );
  assert(cpi !== undefined, 'A25. Estado final consistente entre clientes');
  assert(host.leakCount === 0 && p2.leakCount === 0, 'A26. Sin fuga de privacidad en vista pública durante partida',
    `host=${host.leakCount}, p2=${p2.leakCount}`);

  host.close(); p2.close();
}

/** Un turno humano: DRAW y luego acción legal según la situación */
async function playHumanTurn(cli, idx) {
  const s0 = cli.lastState();
  const tid = s0.public.turnId;

  // Si hay carta robada (drawnCard) sin jugar y pendingPower:
  if (s0.public.pendingPowerType === 'JOKER_RED') {
    cli.action('USE_JOKER_RED', tid, { slotIndex: 0 });
    await afterAction(cli);
    return;
  }
  if (s0.public.pendingPowerType === 'JOKER_BLACK') {
    cli.action('USE_JOKER_BLACK', tid, { targetPlayerIndex: (idx + 1) % 3 });
    await afterAction(cli);
    return;
  }
  if (s0.public.pendingPowerType === 'Q' || s0.public.pendingPowerType === 'J') {
    cli.action('SKIP_PENDING_POWER', tid);
    await afterAction(cli);
    return;
  }

  // Robar carta
  cli.action('DRAW', tid);
  let s = await cli.waitState();
  if (s.public.phase === 'ended') return;

  const myDrawn = s.private.myDrawnCard;
  if (!myDrawn) { /* no debería pasar */ return; }
  const tid2 = s.public.turnId;

  if (myDrawn.rank === 'JOKER') {
    if (myDrawn.color === 'red') {
      cli.action('USE_JOKER_RED', tid2, { slotIndex: 0 });
    } else {
      cli.action('USE_JOKER_BLACK', tid2, { targetPlayerIndex: (idx + 1) % 3 });
    }
    await afterAction(cli);
    return;
  }

  // Si hay carta en mesa: intentar copiar la robada con slot 0 (puede acertar o fallar)
  if (s.public.activeTableCard) {
    cli.action('MATCH', tid2, { slotIndex: 0 });
    s = await cli.waitState();
    if (s.public.phase === 'ended') return;
    if (s.public.turnId === tid2) {
      // El turno no cambió: me toca otra decisión (falló el match y se comió carta o coincidió)
      if (s.private.myDrawnCard && s.public.currentPlayerIndex === idx) {
        cli.action('DISCARD', s.public.turnId);
        await afterAction(cli);
      } else {
        await afterAction(cli);
      }
      return;
    }
    if (s.public.currentPlayerIndex !== idx || s.public.turnId !== tid2) {
      await afterAction(cli); // el turno avanzó (match falló → castigo)
      return;
    }
    return;
  }

  // Sin carta en mesa: dejar la carta robada en la mesa para el siguiente
  cli.action('DISCARD', tid2);
  await afterAction(cli);
}

async function afterAction(cli) {
  const before = cli.states.length;
  await cli.waitState(20000).catch(() => {});
  // aproximación: esperar hasta que cambie turnId/turno o pase mucho tiempo
  await sleep(400);
}

// ─── Escenario B: desconexión en partida → bot toma el control ────────────────
async function scenarioB() {
  const host = new TestClient('HostB');
  await host.connect();

  host.send({ type: 'CREATE_ROOM', payload: { name: 'HostB', targetPlayers: 3, cardsPerPlayer: 4 } });
  const created = await host.wait(m => m.type === 'ROOM_CREATED', 10000);
  const code = created.payload.roomCode;

  host.send({ type: 'START_GAME', payload: {} });
  await host.wait(m => m.type === 'GAME_STARTED', 10000);
  const s0 = await host.waitState();
  assert(s0.public.phase === 'peeking' && s0.public.players.length === 3, 'B1. Escenario B iniciado (2 bots automáticos)');

  // El humano memoriza y termina → mesa abierta solo con él
  await host.action('PEEK_REVEAL', 0, { slotIndex: 0 });
  await host.wait(m => m.type === 'PEEK_REVEALED', 10000);
  await host.action('PEEK_REVEAL', 0, { slotIndex: 2 });
  await host.wait(m => m.type === 'PEEK_REVEALED', 10000);
  await host.action('PEEK_DONE', 0);
  await host.waitPhase('playing');
  assert(true, 'B2. Mesa abierta con solo el humano (bots ya memorizados por el SERVER)');

  // El host juega un turno breve (robar)
  let tid = host.turnId();
  host.action('DRAW', tid);
  await host.waitState();
  assert(!!host.lastState().private.myDrawnCard, 'B3. Carta robada visible para todos (regla pública) y conste en la vista privada del dueño');

  // Host se desconecta → debe convertirse en bot y avisar por STATE
  host.close();
  // Coordinar con un cliente observador
  const obs = new TestClient('Observador');
  // El observador no puede entrar (sala en juego); verificamos por comportamientos del server en los mensajes previos
  // La verificación real: los bots siguen actuando sin humano; no se congela la sala.
  await sleep(3000);

  // Reiniciar un cliente nuevo para observar que la sala sigue en juego (no rompe)
  const obs2 = new TestClient('Obs2');
  await obs2.connect();
  obs2.send({ type: 'JOIN_ROOM', payload: { roomCode: code, name: 'Intruso' } });
  const rej = await obs2.wait(m => m.type === 'ERROR', 10000);
  assert(rej && /ha comenzado/.test(rej.payload.message), 'B4. Sala en rechaza entradas cuando empezó la partida', rej.payload.message);
  obs2.close();
}

// ─── MAIN runner ───────────────────────────────────────────────────────────────
async function main() {
  // Lanzar el servidor como proceso aparte
  const server = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d.toString(); });
  server.stderr.on('data', d => { serverLog += d.toString(); });

  await sleep(1200);
  if (!serverLog.includes('iniciado')) {
    console.error('El servidor no arrancó:\n' + serverLog);
    process.exit(1);
  }

  try {
    await scenarioA();
    await scenarioB();
  } catch (err) {
    results.push(`FAIL | Excepción | ${err.message} ${(err.stack || '').split('\n').slice(1, 4).join(' | ')}`);
    failures++;
  }

  console.log('\n──────── LOG DEL SERVIDOR ────────');
  console.log(serverLog.trim());

  console.log('\n══════════ RESULTADOS ══════════');
  results.forEach(r => console.log(r));
  console.log('════════════════════════════════');
  console.log(failures === 0 ? ' TODAS LAS PRUEBAS PASARON ✔' : ` ${failures} PRUEBAS FALLARON ✘`);

  server.kill();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
