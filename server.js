// server.js - Servidor HTTP y WebSocket AUTORITATIVO para DOSH Online
//
// El servidor es el ÚNICO dueño del estado de la partida:
//  - Las acciones de los clientes son SOLICITUDES que se validan (turno, turnId, legalidad).
//  - El estado oficial vive aquí y nunca se envía completo a los clientes.
//  - Cada cliente recibe una VISTA PÚBLICA + SU VISTA PRIVADA (solo sus cartas conocidas).
//  - Los temporizadores (peek y turno) corren aquí y su vencimiento se procesa UNA sola vez.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

// ─── Motor del juego (misma lógica compartida con el cliente) ─────────────────
const Rules = require('./js/rules.js');
global.Rules  = Rules;                       // game.js consulta Rules/Deck/Player como globales
global.Deck   = require('./js/deck.js');
global.Player = require('./js/player.js');
const BotAI = require('./js/bot.js');
const { createGame } = require('./js/game.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// ─── Configuración de tiempos del SERVIDOR (única autoridad del tiempo) ──────
const TURN_SECONDS     = 30; // Vencimiento del turno → decisión automática
const PEEK_MAX_SECONDS = 45; // Límite total de la fase de memorización online
const BOT_THINK_MIN_MS = 1000; // Ritmo de los bots: pensamiento mínimo entre estados

// MIME types para el servidor de archivos estáticos
const MIME_TYPES = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ─── 1. Servidor HTTP Estático ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  // Health check para Render
  if (reqPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Solo se sirve el front-end público (nunca server.js, package.json, etc.)
  if (reqPath !== '/index.html' && !reqPath.startsWith('/css/') && !reqPath.startsWith('/js/')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 No encontrado');
    return;
  }

  const filePath = path.join(PUBLIC_DIR, reqPath);

  // Prevenir Directory Traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Acceso denegado');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 No encontrado');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ─── 2. Servidor WebSocket ──────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

/**
 * Estructura de Sala:
 * {
 *   code, hostId, targetPlayers, cardsPerPlayer,
 *   status: 'lobby' | 'playing' | 'ended',
 *   players: Array<{ id, name, isBot, ws }>,
 *   engine: instancia de createGame() | null,
 *   peekDone: Set<playerId>,
 *   peekTimer, turnTimer, turnDeadline, botRunning
 * }
 */
const rooms = new Map();

const BOT_NAMES = [
  'Bot Mateo', 'Bot Sofía', 'Bot Lucas', 'Bot Valentina',
  'Bot Camilo', 'Bot Elena', 'Bot Diego', 'Bot Isabella'
];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function safeSend(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(message)); } catch (e) { console.error('[WS] send falló:', e.message); }
  }
}

function broadcastToRoom(room, message, excludeWs = null) {
  room.players.forEach(p => {
    if (!p.isBot && p.ws && p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(message));
    }
  });
}

function sendError(ws, message) {
  safeSend(ws, { type: 'ERROR', payload: { message } });
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. VISTAS DE ESTADO (el filtrado de información ocurre AQUÍ, en el servidor)
// ═════════════════════════════════════════════════════════════════════════════

function cardLabel(card) {
  if (!card) return '?';
  const sym = Deck.getSuitSymbol(card.suit);
  return card.rank === 'JOKER' ? `JOKER${sym}` : `${card.rank}${sym}`;
}

/** Vista pública: todo lo que TODOS los jugadores pueden ver. */
function publicView(room, notice = null, fx = null) {
  const s = room.engine.state;
  const ended = s.gameStatus === 'ended';

  // Al terminar la partida, todas las manos se revelan con sus puntajes
  let scoreResults = null;
  if (ended) {
    scoreResults = s.players.map((p, idx) => {
      let score = 0;
      p.hand.forEach(slot => {
        if (slot && slot.card) {
          slot.card.faceUp = true;
          score += Rules.getCardValue(slot.card);
        }
      });
      return {
        index: idx,
        name: p.name,
        isBot: p.isBot,
        score,
        cards: p.hand.map(sl => sl.card ? { ...sl.card, faceUp: true } : null),
      };
    });
    const minScore = Math.min(...scoreResults.map(r => r.score));
    scoreResults.forEach(r => { r.isWinner = r.score === minScore; });
  }

  return {
    phase: s.gameStatus,
    currentPlayerIndex: s.currentPlayerIndex,
    turnId: s.turnId,
    turnSecondsLeft: (room.status === 'playing' && room.turnDeadline)
      ? Math.max(0, Math.ceil((room.turnDeadline - Date.now()) / 1000))
      : null,
    cardsPerPlayer: s.cardsPerPlayer,
    players: s.players.map((p, idx) => ({
      index: idx,
      name: p.name,
      isBot: p.isBot,
      handCount: p.hand.length,
      penaltyCount: p.penaltyCount || 0,
      // Solo en fase 'ended' se revelan las manos completas a todos
      hand: ended ? p.hand.map(sl => ({ faceUp: true, known: true, card: sl.card ? { ...sl.card } : null })) : null,
    })),
    deckCount: s.deck.length,
    tableHistory: s.tableHistory.filter(c => c).map(c => ({ ...c, faceUp: true })),
    activeTableCard: s.activeTableCard ? { ...s.activeTableCard, faceUp: true } : null,
    hasDrawnCard: !!s.drawnCard, // alguien sostiene la carta robada
    hasDrawnFromTable: !!s.drawnFromTable, // la sostenida salió de la mesa (no del mazo)
    // REGLA: la carta volteada del mazo es PÚBLICA (todos la ven para memorizarla)
    drawnCard: s.drawnCard ? { ...s.drawnCard, faceUp: true } : null,
    doshAnnouncedBy: s.doshAnnouncedBy,
    lastRoundTurnsLeft: s.lastRoundTurnsLeft,
    pendingPowerType: s.pendingDiscardPower ? s.pendingDiscardPower.type : null,
    qChainActive: s.qChainActive,
    jPowerUsable: !!s.jPowerUsable,
    jokerBlackBlocked: s.jokerBlackBlocked,
    tableCardMatchedThisTurn: s.tableCardMatchedThisTurn,
    ended,
    scoreResults,
    notice,
    // fx: instrucciones de ANIMACIÓN derivadas de esta acción (solo datos públicos).
    // Todos los clientes ejecutan la misma animación, como en modo local.
    fx: fx || null,
  };
}

/** Vista privada: SOLO lo que este jugador conoce por reglas del juego. */
function privateView(room, playerIndex) {
  const s = room.engine.state;
  const p = s.players[playerIndex];
  if (!p) return { myIndex: playerIndex, myHand: [], myDrawnCard: null };

  return {
    myIndex: playerIndex,
    myHand: p.hand.map(slot => ({
      known: !!slot.known,
      faceUp: !!slot.faceUp,
      // PRIVACIDAD: la identidad solo viaja si el jugador la conoce por reglas
      card: (slot.known || slot.faceUp) && slot.card ? { ...slot.card } : null,
    })),
    // La carta robada solo se envía a quien la robó (sigue siendo privada)
    myDrawnCard: (s.drawnCard && playerIndex === s.currentPlayerIndex) ? { ...s.drawnCard } : null,
  };
}

/**
 * Envía a CADA cliente su versión filtrada del estado.
 * @param {Object} room
 * @param {{text,type}|null} notice   - Aviso público (para todos)
 * @param {{text,type}|null} personal - Aviso extra para quien actuó (completado abajo por el despachador)
 * @param {{text,type}|null} personalFor - si se pasa, personal se muestra solo a ese índice
 */
function broadcastState(room, notice = null, personal = null, personalForIndex = null, fx = null) {
  if (!room.engine) return;
  const s = room.engine.state;
  const currentId = s.players[s.currentPlayerIndex] ? s.players[s.currentPlayerIndex].id : null;

  room.players.forEach(p => {
    if (p.isBot || !p.ws) return;
    const myIndex = findEngineIndexByRoomId(room, p.id);
    if (myIndex === -1) return;

    const payload = {
      public: publicView(room, notice, fx),
      private: privateView(room, myIndex),
    };
    if (personal) {
      const forMe = (personalForIndex !== null)
        ? myIndex === personalForIndex
        : s.players[myIndex].id === currentId;
      if (forMe) payload.personal = personal;
    }
    safeSend(p.ws, { type: 'STATE', payload });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. TEMPORIZADORES OFICIALES (procesados UNA sola vez, aquí en el servidor)
// ═════════════════════════════════════════════════════════════════════════════

function clearTimers(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.peekTimer) { clearTimeout(room.peekTimer); room.peekTimer = null; }
  room.turnDeadline = null;
}

/** Programa el vencimiento del turno actual. Se llama en cada cambio de turno real. */
function scheduleTurnTimer(room) {
  if (!room.engine) return;
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }

  const s = room.engine.state;
  if (!(s.gameStatus === 'playing' || s.gameStatus === 'dosh')) {
    room.turnDeadline = null;
    return;
  }

  room.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  room.turnTimer = setTimeout(() => onTurnTimeout(room), TURN_SECONDS * 1000 + 60);
}

/** Vencimiento del turno: se ejecuta UNA sola vez y con estado actual. */
function onTurnTimeout(room) {
  room.turnTimer = null;
  if (!room.engine) return;

  const s = room.engine.state;
  if (!(s.gameStatus === 'playing' || s.gameStatus === 'dosh')) return;

  const current = s.players[s.currentPlayerIndex];
  const name = current ? current.name : '?';
  const notice = { text: `⏱ ¡Se acabó el tiempo (30s) de ${name}!`, type: 'warning' };

  try {
    if (s.pendingDiscardPower) {
      if (s.pendingDiscardPower.type === 'Q' || s.pendingDiscardPower.type === 'J') {
        applyEngine(room, 'skipPendingPower', [], notice);
        return;
      } else if (s.pendingDiscardPower.type === 'JOKER_RED') {
        applyEngine(room, 'useJokerRedPower', [0], notice);
        return;
      } else if (s.pendingDiscardPower.type === 'JOKER_BLACK') {
        applyEngine(room, 'useJokerBlackPower', [(s.currentPlayerIndex + 1) % s.players.length], notice);
        return;
      }
    } else if (s.drawnCard && s.drawnCard.rank === 'JOKER') {
      if (s.drawnCard.color === 'red') {
        applyEngine(room, 'useJokerRedPower', [0], notice);
        return;
      } else {
        applyEngine(room, 'useJokerBlackPower', [(s.currentPlayerIndex + 1) % s.players.length], notice);
        return;
      }
    } else if (s.drawnCard) {
      notice.text = `⏱ Tiempo agotado: ${name} dejó su carta en la mesa.`;
      applyEngine(room, 'discardDrawnCard', [], notice);
      return;
    } else {
      room.engine.breakQChain();
      applyEngine(room, 'nextTurn', [], notice);
      return;
    }
  } catch (e) {
    console.error('[TurnTimeout] Error:', e);
    // Último recurso: avanzar el turno para que la partida nunca quede congelada
    try {
      room.engine.nextTurn();
      afterStateChange(room, { text: `⏱ Tiempo agotado de ${name}.`, type: 'warning' });
    } catch (e2) {
      console.error('[TurnTimeout] Error crítico:', e2);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. APLICAR ACCIONES AL ENGINE + POST-PROCESO
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Aplica una función del engine una sola vez y emite el estado.
 * Los avisos pueden ser un objeto {text,type} o una función que recibe el resultado.
 * Si el engine rechaza la acción, NO se emite estado ni se avanza nada.
 *
 * @returns el resultado del engine (o null)
 */
function applyEngine(room, fnName, args = [], notice = null, personal = null, personalForIndex = null, fx = null) {
  const engine = room.engine;
  if (!engine) return null;

  const result = engine[fnName](...args);
  if (result && result.success === false) return result; // acción ilegal: nada cambió

  const n = (typeof notice === 'function') ? notice(result) : notice;
  const pr = (typeof personal === 'function') ? personal(result) : personal;
  const fxv = (typeof fx === 'function') ? fx(result, args) : fx;
  afterStateChange(room, n || null, pr || null, personalForIndex, fxv || null);
  return result;
}

/**
 * Después de CUALQUIER cambio de estado válido:
 *  1. Notificar a todos con vistas filtradas.
 *  2. Si cambió el turno (turnId) → reprogramar el timer oficial del turno.
 *  3. Si el jugador activo es un bot → ejecutar su turno en el servidor.
 */
function afterStateChange(room, notice = null, personal = null, personalForIndex = null, fx = null) {
  if (!room.engine) return;

  const s = room.engine.state;

  // 1. Reprogramar el deadline ANTES de emitir: la emisión ya lleva la cuenta atrás correcta
  scheduleTurnTimer(room);

  // 2. Reconstruir la memoria de los bots desde lo OBJETIVAMENTE conocido:
  //    así los bots nunca actúan con recuerdos desalineados (evita fallos en bucle).
  syncBotMemories(room);

  // 3. Notificar a todos con vistas filtradas y, si es turno de bot, ejecutarlo.
  broadcastState(room, notice, personal, personalForIndex, fx);

  if (s.gameStatus === 'ended') {
    clearTimers(room);
    room.status = 'ended';
    console.log(`[Partida Terminada] Sala: ${room.code}`);
    return;
  }

  maybeRunBotTurn(room);
}

/** La memoria oficial de cada bot SIEMPRE se deriva de sus slots 'known' del engine. */
function syncBotMemories(room) {
  if (!room.engine) return;
  const s = room.engine.state;
  s.players.forEach((p, idx) => {
    if (!p.isBot) return;
    // Mutamos SIEMPRE el MISMO objeto de memoria (nunca reemplazarlo):
    // los bots en curso guardan esa referencia y la verían desactualizada.
    const mem = BotAI.getBotMemory(idx);
    mem.knownSlots.clear();
    mem.knownRivals.clear();
    p.hand.forEach((slot, sIdx) => {
      if (slot && slot.known && slot.card) BotAI.recordCardInMemory(idx, sIdx, slot.card);
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. BOTS (la IA corre en el SERVIDOR; se reutiliza bot.js intacto)
// ═════════════════════════════════════════════════════════════════════════════

function maybeRunBotTurn(room) {
  if (!room.engine || room.status !== 'playing') return;
  const s = room.engine.state;
  if (!(s.gameStatus === 'playing' || s.gameStatus === 'dosh')) return;

  const current = s.players[s.currentPlayerIndex];
  if (!current || !current.isBot || room.botRunning) return;

  room.botRunning = true;
  const botIndex = s.currentPlayerIndex;

  setTimeout(async () => {
    try {
      await runBotTurn(room, botIndex);
    } catch (e) {
      console.error('[Bot] Error en turno de bot:', e);
    } finally {
      room.botRunning = false;
      maybeRunBotTurn(room); // por si el turno siguió en otro bot
    }
  }, BOT_THINK_MIN_MS + Math.random() * 900);
}

/** Ejecuta el turno de un bot contra el estado autoritativo. */
async function runBotTurn(room, botIndex) {
  const engine = room.engine;
  if (!engine) return;
  const s = engine.state;
  // Guarda anti-carrera: si el turno cambió, no actuar
  if (s.currentPlayerIndex !== botIndex) return;

  const da = s.players[botIndex] ? s.players[botIndex].name : 'Bot';

  // Red de seguridad: si no puede robar (sin mazo, sin mesa y sin carta en juego),
  // pasar el turno para NUNCA congelar la sala.
  if (!s.drawnCard && !s.activeTableCard && s.deck.length === 0) {
    applyEngine(room, 'nextTurn', [], { text: `🤖 ${da} no puede robar (mazo y mesa vacíos). Pasa el turno.`, type: 'info' });
    return;
  }

  await BotAI.playTurn(botIndex, s, {
    announceDosh: () => {
      applyEngine(room, 'announceDosh', [], (r) => r
        ? { text: `🔥 ¡${da} CANTÓ DOSH! Todos los demás tendrán un último turno.`, type: 'warning' } : null);
    },
    useQPeek: async (slotIdx) => {
      applyEngine(room, 'useQPower', [slotIdx],
        (r) => r ? { text: `👁 ${da} usó la Q para ver una carta propia.`, type: 'info' } : null);
    },
    matchWithTable: async (slotIdx) => {
      const r1 = engine.useTableCardForCurrentPlayer();
      if (!r1 || !r1.success) return;
      const r = applyEngine(room, 'matchCardWithDrawn', [slotIdx], null);
      if (r && r.success) {
        const fx = (!r.gameEnded && r.matched)
          ? { land: { p: botIndex, s: slotIdx, card: r.removedCard } }
          : (!r.gameEnded ? { penalty: { p: botIndex } } : null);
        afterStateChange(room, buildMatchNoticePublic(room, botIndex, r), null, null, fx);
      }
    },
    replaceWithTable: async (slotIdx) => {
      const r1 = engine.useTableCardForCurrentPlayer();
      if (!r1 || !r1.success) return;
      applyEngine(room, 'replaceCardWithDrawn', [slotIdx],
        (r) => r ? { text: `♻ ${da} cambió una carta. La ${cardLabel(r.oldCard)} quedó en la mesa.`, type: 'success' } : null,
        null, null,
        (r) => r ? { land: { p: botIndex, s: slotIdx, card: r.oldCard } } : null);
    },
    drawFromDeck: async () => {
      applyEngine(room, 'drawCardForCurrentPlayer', [],
        (r) => r ? { text: `🂠 ${da} volteó una carta del mazo.`, type: 'info' } : null);
    },
    useJokerRed: async (slotIdx) => {
      applyEngine(room, 'useJokerRedPower', [slotIdx],
        (r) => r ? { text: `🔥 ${da} botó una carta con el Joker Rojo.`, type: 'warning' } : null,
        null, null,
        (r, a) => (r && !r.gameEnded) ? { land: { p: botIndex, s: a[0], card: r.removedCard } } : null);
    },
    useJokerBlack: async (targetIdx) => {
      applyEngine(room, 'useJokerBlackPower', [targetIdx],
        (r) => r ? { text: `⚡ ${da} castigó a ${s.players[targetIdx]?.name ?? '?'} (+2 cartas).`, type: 'warning' } : null,
        null, null,
        (r) => r ? { penalty: { p: targetIdx } } : null);
    },
    useJSwap: async (mySlot, rivalIdx, rivalSlot) => {
      applyEngine(room, 'useJPower', [mySlot, rivalIdx, rivalSlot],
        (r) => r ? { text: `🔄 ${da} intercambió una carta con ${s.players[rivalIdx]?.name ?? '?'} (boca abajo).`, type: 'info' } : null,
        null, null,
        (r) => r ? { swap: { ap: botIndex, as: mySlot, bp: rivalIdx, bs: rivalSlot } } : null);
    },
    matchWithDrawn: async (slotIdx) => {
      const r = applyEngine(room, 'matchCardWithDrawn', [slotIdx], null);
      if (r && r.success) {
        const fx = (!r.gameEnded && r.matched)
          ? { land: { p: botIndex, s: slotIdx, card: r.removedCard } }
          : (!r.gameEnded ? { penalty: { p: botIndex } } : null);
        afterStateChange(room, buildMatchNoticePublic(room, botIndex, r), null, null, fx);
      }
    },
    replaceWithDrawn: async (slotIdx) => {
      applyEngine(room, 'replaceCardWithDrawn', [slotIdx],
        (r) => r ? { text: `♻ ${da} cambió una carta. La ${cardLabel(r.oldCard)} quedó en la mesa.`, type: 'success' } : null,
        null, null,
        (r) => r ? { land: { p: botIndex, s: slotIdx, card: r.oldCard } } : null);
    },
    discardDrawn: async () => {
      applyEngine(room, 'discardDrawnCard', [],
        (r) => r ? { text: `${da} dejó su carta en la mesa.`, type: 'info' } : null);
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. FASE DE MEMORIZACIÓN (PEEK)
// ═════════════════════════════════════════════════════════════════════════════

function handlePeekReveal(room, ws, playerIndex, payload) {
  const s = room.engine.state;
  if (s.gameStatus !== 'peeking') return;

  const player = s.players[playerIndex];
  const slotIndex = Number(payload.slotIndex);
  const maxAllowed = s.cardsPerPlayer / 2;

  if (!player || !player.hand[slotIndex] || !player.hand[slotIndex].card) {
    sendError(ws, 'Posición inválida.');
    return;
  }
  if (player.hand[slotIndex].known) {
    // Idempotente: reenvía la misma carta sin avanzar el contador
    safeSend(ws, { type: 'PEEK_REVEALED', payload: { slotIndex, card: { ...player.hand[slotIndex].card } } });
    return;
  }
  const alreadyKnown = player.hand.filter(sl => sl.known).length;
  if (alreadyKnown >= maxAllowed) {
    sendError(ws, 'Ya viste todas las cartas permitidas.');
    return;
  }

  player.hand[slotIndex].known = true; // El servidor registra que ESTE jugador la conoce
  // La identidad va SOLO a este cliente: es su información privada
  safeSend(ws, { type: 'PEEK_REVEALED', payload: { slotIndex, card: { ...player.hand[slotIndex].card } } });
}

function handlePeekDone(room, ws, playerIndex) {
  const s = room.engine.state;
  if (s.gameStatus !== 'peeking') return;

  room.peekDone.add(s.players[playerIndex].id);
  console.log(`[Peek Listo] ${room.peekDone.size}/${s.players.length} jugadores listos en sala ${room.code}`);
  checkAllPeekDone(room);
}

function checkAllPeekDone(room) {
  if (!room.engine || room.engine.state.gameStatus !== 'peeking') return;
  const humans = room.engine.state.players.filter(p => !p.isBot);
  if (humans.every(h => room.peekDone.has(h.id))) openTable(room);
}

/** Deadline de la fase peek: la mesa se abre aunque alguien no responda. */
function schedulePeekTimer(room) {
  if (room.peekTimer) clearTimeout(room.peekTimer);
  room.peekTimer = setTimeout(() => {
    room.peekTimer = null;
    if (room.engine && room.engine.state.gameStatus === 'peeking') {
      console.log(`[Peek Timeout] Sala ${room.code}: abriendo mesa por límite de tiempo.`);
      openTable(room);
    }
  }, PEEK_MAX_SECONDS * 1000);
}

function openTable(room) {
  if (!room.engine || room.engine.state.gameStatus !== 'peeking') return;
  if (room.peekTimer) { clearTimeout(room.peekTimer); room.peekTimer = null; }

  room.engine.startPlayingPhase(); // playing, turnId = 1, turno del jugador 0
  console.log(`[Mesa Abierta] Sala: ${room.code}`);

  // Programar PRIMERO el deadline del turno para que la primera emisión ya
  // incluya la cuenta atrás que el cliente debe mostrar.
  scheduleTurnTimer(room);

  const firstPlayer = room.engine.state.players[0];
  afterStateChange(room, { text: `¡Mesa abierta! Turno de ${firstPlayer.name}.`, type: 'info' });
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. VALIDACIÓN Y DESPACHO DE SOLICITUDES DE JUEGO
// ═════════════════════════════════════════════════════════════════════════════

function findPlayerIndexByWs(room, ws) {
  return findEngineIndexByRoomId(room, ws.clientId);
}

/** El engine guarda el id de la sala en player.botId (ver game.js initGame). */
function findEngineIndexByRoomId(room, roomId) {
  return room.engine.state.players.findIndex(p => p.botId === roomId);
}

/**
 * Procesa una solicitud de acción durante la partida.
 * Valida: sala activa, autor (jugador correcto), turnId vigente y legalidad (engine).
 */
function handleGameAction(room, ws, payload) {
  if (room.status !== 'playing' || !room.engine) {
    sendError(ws, 'La partida no está en curso.');
    return;
  }

  const playerIndex = findPlayerIndexByWs(room, ws);
  if (playerIndex === -1) {
    sendError(ws, 'No estás en esta sala.');
    return;
  }

  const s = room.engine.state;
  const action = payload.action;

  // ── Acciones de PEEK (fase de memoria): cualquier jugador, sin turno ──
  if (s.gameStatus === 'peeking') {
    if (action === 'PEEK_REVEAL') {
      handlePeekReveal(room, ws, playerIndex, payload);
    } else if (action === 'PEEK_DONE') {
      handlePeekDone(room, ws, playerIndex);
    } else {
      sendError(ws, 'Acción inválida durante la fase de memorización.');
    }
    return;
  }

  if (s.gameStatus === 'ended') {
    sendError(ws, 'La partida ya terminó.');
    return;
  }

  // ── Acciones de turno: SOLO del jugador activo y con turnId vigente ──
  if (playerIndex !== s.currentPlayerIndex) {
    sendError(ws, 'No es tu turno.');
    return;
  }

  const sentTurnId = Number(payload.turnId);
  if (!Number.isInteger(sentTurnId) || sentTurnId !== s.turnId) {
    // Acción atrasada o duplicada: se rechaza SIN avanzar nada
    safeSend(ws, { type: 'ACTION_STALE', payload: { message: 'Acción fuera de tiempo (el turno ya avanzó).' } });
    return;
  }

  const name = s.players[playerIndex].name;
  let result = null;

  switch (action) {
    case 'DRAW': {
      result = applyEngine(room, 'drawCardForCurrentPlayer', [],
        (r) => {
          if (!r) return null;
          let text = `🂠 ${name} volteó una carta del mazo.`;
          if (r.reshuffled) text += ' 🔀 ¡Cartas agotadas! Se rebarajaron las de la mesa.';
          return { text, type: 'info' };
        },
        null,
        (r) => r ? { text: `Volteaste ${cardLabel(r.card)} del mazo.`, type: 'info' } : null,
        playerIndex);
      break;
    }

    case 'USE_TABLE': {
      result = applyEngine(room, 'useTableCardForCurrentPlayer', [],
        (r) => r ? { text: `↩ ${name} tomó la carta de la mesa.`, type: 'info' } : null);
      break;
    }

    case 'REPLACE': {
      result = applyEngine(room, 'replaceCardWithDrawn', [payload.slotIndex],
        (r) => r ? { text: `♻ ${name} cambió una carta. La ${cardLabel(r.oldCard)} quedó en la mesa.`, type: 'success' } : null,
        (r) => r && r.pendingPower ? { text: `¡Botaste un poder especial! (${r.pendingPower})`, type: 'warning' } : null,
        playerIndex,
        (r, a) => r ? { land: { p: playerIndex, s: a[0], card: r.oldCard } } : null);
      break;
    }

    case 'MATCH': {
      result = applyEngine(room, 'matchCardWithDrawn', [payload.slotIndex],
        (r) => r ? buildMatchNoticePublic(room, playerIndex, r) : null,
        (r) => {
          if (!r) return null;
          if (r.matched) return { text: `✅ ¡Copia correcta! Usaste un ${cardLabel(r.removedCard)} y le quedan ${s.players[playerIndex].hand.length}.`, type: 'success' };
          return { text: `❌ ¡No era igual! Era un ${cardLabel(r.revealedCard)}. Te comes una carta del mazo sin verla.`, type: 'error' };
        },
        playerIndex,
        (r, a) => {
          if (!r || r.gameEnded) return null;
          if (r.matched) return { land: { p: playerIndex, s: a[0], card: r.removedCard } };
          return { penalty: { p: playerIndex } };
        });
      break;
    }

    case 'DISCARD': {
      result = applyEngine(room, 'discardDrawnCard', [],
        (r) => r ? { text: `${name} dejó su ${cardLabel(r.discarded)} en la mesa.`, type: 'info' } : null);
      break;
    }

    case 'USE_Q_PEEK': {
      result = applyEngine(room, 'useQPower', [payload.slotIndex],
        (r) => r ? { text: `👁 ${name} usó la Q para ver una carta propia.`, type: 'info' } : null,
        (r) => r ? { text: `👁 Viste tu carta: ${cardLabel(r.card)}.`, type: 'info' } : null,
        playerIndex);
      break;
    }

    case 'SKIP_PENDING_POWER': {
      result = applyEngine(room, 'skipPendingPower', [],
        (r) => r ? { text: `${name} decidió no usar el poder pendiente.`, type: 'info' } : null);
      break;
    }

    case 'BREAK_Q_CHAIN': {
      room.engine.breakQChain();
      result = applyEngine(room, 'nextTurn', [],
        { text: `${name} no usó la Q y rompió la cadena.`, type: 'info' });
      break;
    }

    case 'PASS_TURN': {
      room.engine.breakQChain();
      result = applyEngine(room, 'nextTurn', [],
        { text: `${name} decidió dejar la carta en la mesa y pasó el turno.`, type: 'info' });
      break;
    }

    case 'USE_J_SWAP': {
      result = applyEngine(room, 'useJPower', [payload.mySlot, payload.targetPlayerIndex, payload.targetSlotIndex],
        (r) => r ? { text: `🔄 ${name} intercambió una carta con ${s.players[payload.targetPlayerIndex]?.name ?? '?'} (boca abajo).`, type: 'info' } : null,
        null, null,
        (r) => r ? { swap: { ap: playerIndex, as: payload.mySlot, bp: payload.targetPlayerIndex, bs: payload.targetSlotIndex } } : null);
      break;
    }

    case 'USE_JOKER_RED': {
      result = applyEngine(room, 'useJokerRedPower', [payload.slotIndex],
        (r) => r ? { text: `🔥 ${name} botó una carta con el Joker Rojo.`, type: 'warning' } : null,
        null, null,
        (r, a) => (r && !r.gameEnded) ? { land: { p: playerIndex, s: a[0], card: r.removedCard } } : null);
      break;
    }

    case 'USE_JOKER_BLACK': {
      result = applyEngine(room, 'useJokerBlackPower', [payload.targetPlayerIndex],
        (r) => r ? { text: `⚡ ${name} castigó a ${s.players[payload.targetPlayerIndex]?.name ?? '?'} (+2 cartas).`, type: 'warning' } : null,
        null, null,
        (r) => r ? { penalty: { p: payload.targetPlayerIndex } } : null);
      break;
    }

    case 'ANNOUNCE_DOSH': {
      result = applyEngine(room, 'announceDosh', [],
        (r) => r ? { text: `🔥 ¡${name} CANTÓ DOSH! Todos los demás tendrán un último turno.`, type: 'warning' } : null);
      break;
    }

    default:
      sendError(ws, `Acción desconocida: ${action}`);
      return;
  }

  if (result && result.success === false && result.error) {
    // Acción ilegal: se informa SOLO a quien la pidió; el estado oficial no cambió
    safeSend(ws, { type: 'ACTION_ERROR', payload: { message: result.error } });
  }
}

/** Aviso público del resultado de una copia (match). */
function buildMatchNoticePublic(room, actorIdx, r) {
  const s = room.engine.state;
  const name = s.players[actorIdx] ? s.players[actorIdx].name : '?';
  if (!r || !r.success) return null;
  if (r.matched) {
    return {
      text: `✅ ¡Copia correcta! ${name} eliminó su ${cardLabel(r.removedCard)} y le quedan ${s.players[actorIdx].hand.length}.`,
      type: 'success',
    };
  }
  return {
    text: `❌ ¡No era igual! ${name} tenía un ${cardLabel(r.revealedCard)} y se comió +1 carta del mazo.`,
    type: 'error',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. Iniciar partida (guardar acción INICIAR PARTIDA del host)
// ═════════════════════════════════════════════════════════════════════════════

function startOnlineGame(room) {
  // Rellenar con bots si faltan jugadores
  const botsNeeded = room.targetPlayers - room.players.length;
  if (botsNeeded > 0) {
    for (let i = 0; i < botsNeeded; i++) {
      room.players.push({
        id: 'bot_' + Math.random().toString(36).substring(2, 9),
        name: BOT_NAMES[i % BOT_NAMES.length],
        isBot: true,
        ws: null,
      });
    }
  }

  room.status = 'playing';
  room.peekDone = new Set();

  // ── EL SERVIDOR BARAJA Y REPARTE: nada del mazo viaja a los clientes ──
  room.engine = createGame();
  const playerInfos = room.players.map(p => ({ name: p.name, isBot: p.isBot, id: p.id }));
  const res = room.engine.initGame(playerInfos, room.cardsPerPlayer);
  if (!res.success) {
    console.error(`[Error] No se pudo iniciar la partida en sala ${room.code}: ${res.error}`);
    broadcastToRoom(room, { type: 'ERROR', payload: { message: res.error } });
    room.engine = null;
    room.status = 'lobby';
    return;
  }

  // Bots: "memoria" de la mitad de sus cartas (equivale a su peek)
  // y el resto del conocimiento se deriva siempre del estado real (syncBotMemories)
  const s = room.engine.state;
  s.players.forEach((p, idx) => {
    if (p.isBot) {
      const canSee = Math.floor(room.cardsPerPlayer / 2);
      for (let i = 0; i < canSee; i++) {
        if (p.hand[i] && p.hand[i].card) {
          p.hand[i].known = true;
          p.hand[i].faceUp = false;
        }
      }
    }
  });

  const humanCount = s.players.filter(p => !p.isBot).length;
  const botCount = s.players.length - humanCount;
  console.log(`[Partida Iniciada] Sala: ${room.code} | Total: ${s.players.length} (${humanCount} humanos, ${botCount} bots)`);

  // Meta de inicio SIN mazo: solo la lista de participantes.
  // IMPORTANTE: 'id' debe ser el id de SALA (botId en el engine), NO el índice
  // del motor; el cliente lo usa para saber qué jugador es él.
  broadcastToRoom(room, {
    type: 'GAME_STARTED',
    payload: {
      roomCode: room.code,
      cardsPerPlayer: room.cardsPerPlayer,
      players: s.players.map((p, idx) => ({ id: p.botId ?? p.id, name: p.name, isBot: p.isBot, index: idx })),
    },
  });

  // Estado inicial a cada cliente (vistas filtradas) + deadline de peek oficial
  broadcastState(room, null);
  schedulePeekTimer(room);
}

// ═════════════════════════════════════════════════════════════════════════════
// 10. Salas: creación, unión, inicio, salida, lobby
// ═════════════════════════════════════════════════════════════════════════════

wss.on('connection', (ws) => {
  ws.clientId = 'user_' + Math.random().toString(36).substring(2, 9);
  ws.currentRoomCode = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleClientMessage(ws, msg);
    } catch (e) {
      console.error('Error parseando mensaje WS:', e);
    }
  });

  ws.on('close', () => handleClientDisconnect(ws));
  ws.on('error', () => { /* el close ya se encarga */ });
});

// Heartbeat: mantiene viva la conexión detrás del proxy de Render y limpia clientes muertos
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 25000);

function roomSummary(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, isBot: p.isBot }));
}

function handleClientMessage(ws, msg) {
  const { type, payload = {} } = msg;
  const room = ws.currentRoomCode ? rooms.get(ws.currentRoomCode) : null;

  switch (type) {
    case 'CREATE_ROOM': {
      const { name, targetPlayers, cardsPerPlayer } = payload;
      const count = Math.max(3, Math.min(8, Number(targetPlayers) || 3));
      const cards = Math.max(4, Math.min(8, Number(cardsPerPlayer) || 4));
      const code = generateRoomCode();

      const newRoom = {
        code,
        hostId: ws.clientId,
        targetPlayers: count,
        cardsPerPlayer: cards,
        status: 'lobby',
        players: [{
          id: ws.clientId,
          name: (name || 'Jugador 1').trim().substring(0, 16),
          isBot: false,
          ws: ws,
        }],
        engine: null,
        peekDone: new Set(),
        peekTimer: null,
        turnTimer: null,
        turnDeadline: null,
        botRunning: false,
      };

      rooms.set(code, newRoom);
      ws.currentRoomCode = code;

      safeSend(ws, {
        type: 'ROOM_CREATED',
        payload: {
          roomCode: code,
          targetPlayers: count,
          cardsPerPlayer: cards,
          isHost: true,
          myId: ws.clientId,
          players: roomSummary(newRoom),
        },
      });
      console.log(`[Sala Creada] Código: ${code} | Anfitrión: ${name} | Cupo: ${count}`);
      break;
    }

    case 'JOIN_ROOM': {
      const { roomCode, name } = payload;
      const code = (roomCode || '').toUpperCase().trim();
      const targetRoom = rooms.get(code);

      if (!targetRoom) {
        sendError(ws, 'La sala no existe.');
        return;
      }
      if (targetRoom.status !== 'lobby') {
        sendError(ws, 'La partida en esta sala ya ha comenzado.');
        return;
      }
      if (targetRoom.players.length >= targetRoom.targetPlayers) {
        sendError(ws, 'La sala ya está llena.');
        return;
      }

      targetRoom.players.push({
        id: ws.clientId,
        name: (name || `Jugador ${targetRoom.players.length + 1}`).trim().substring(0, 16),
        isBot: false,
        ws: ws,
      });
      ws.currentRoomCode = code;

      safeSend(ws, {
        type: 'ROOM_JOINED',
        payload: {
          roomCode: code,
          targetPlayers: targetRoom.targetPlayers,
          cardsPerPlayer: targetRoom.cardsPerPlayer,
          isHost: ws.clientId === targetRoom.hostId,
          myId: ws.clientId,
          players: roomSummary(targetRoom),
        },
      });

      broadcastToRoom(targetRoom, { type: 'ROOM_UPDATE', payload: { players: roomSummary(targetRoom) } }, ws);
      console.log(`[Jugador Unido] Sala: ${code} | Jugador: ${player_name(targetRoom, ws.clientId)} (${targetRoom.players.length}/${targetRoom.targetPlayers})`);
      break;
    }

    case 'START_GAME': {
      if (!room) return;
      if (ws.clientId !== room.hostId) {
        sendError(ws, 'Solo el creador de la sala puede iniciar la partida.');
        return;
      }
      if (room.status !== 'lobby') return;

      startOnlineGame(room);
      break;
    }

    case 'GAME_ACTION': {
      if (!room || !room.engine) return;
      handleGameAction(room, ws, payload || {});
      break;
    }

    case 'LEAVE_ROOM': {
      handleClientDisconnect(ws);
      break;
    }

    case 'BACK_TO_LOBBY': {
      // Solo el host, y solo cuando la partida terminó
      if (!room || room.status !== 'ended') return;
      if (ws.clientId !== room.hostId) return;

      clearTimers(room);
      room.engine = null;
      room.status = 'lobby';
      room.botRunning = false;
      room.peekDone = new Set();
      // Quitar los bots; quien se desconectó puede reingresar como jugador nuevo
      room.players = room.players.filter(p => !p.isBot);

      if (room.players.length === 0) {
        rooms.delete(room.code);
        break;
      }
      if (!room.players.some(p => p.id === room.hostId)) {
        room.hostId = room.players[0].id;
      }

      broadcastToRoom(room, {
        type: 'BACK_TO_LOBBY',
        payload: {
          roomCode: room.code,
          targetPlayers: room.targetPlayers,
          cardsPerPlayer: room.cardsPerPlayer,
          players: roomSummary(room),
        },
      });
      console.log(`[De Regreso al Lobby] Sala: ${room.code}`);
      break;
    }
  }
}

function player_name(room, clientId) {
  const p = room.players.find(x => x.id === clientId);
  return p ? p.name : '?';
}

function handleClientDisconnect(ws) {
  const code = ws.currentRoomCode;
  if (!code) return;

  const room = rooms.get(code);
  if (!room) return;

  const index = room.players.findIndex(p => p.id === ws.clientId);
  if (index !== -1) {
    const player = room.players[index];

    // EN PARTIDA ACTIVA: el jugador se convierte en bot para no romper los índices
    if (room.status === 'playing' && room.engine && !player.isBot) {
      const s = room.engine.state;
      const idxInGame = findEngineIndexByRoomId(room, player.id);
      player.isBot = true;
      player.ws = null;
      if (room.peekDone) room.peekDone.add(player.id); // no bloquear la apertura de mesa
      if (idxInGame !== -1) {
        checkAllPeekDone(room);
        afterStateChange(room, { text: `⛔ ${player.name} se desconectó; un Bot tomará el control de sus cartas.`, type: 'error' });
      }
    } else {
      // En lobby o sala terminada: se elimina normalmente
      room.players.splice(index, 1);
      console.log(`[Desconexión] ${player.name} salió de la sala ${code}`);

      const remainingHumans = room.players.filter(p => !p.isBot);
      if (remainingHumans.length === 0) {
        clearTimers(room);
        rooms.delete(code);
        console.log(`[Sala Eliminada] ${code} (sin jugadores humanos)`);
        ws.currentRoomCode = null;
        return;
      }

      if (room.hostId === ws.clientId) {
        room.hostId = remainingHumans[0].id;
        safeSend(remainingHumans[0].ws, { type: 'YOU_ARE_HOST', payload: { isHost: true } });
      }

      broadcastToRoom(room, {
        type: 'PLAYER_LEFT',
        payload: { playerId: ws.clientId, playerName: player.name, players: roomSummary(room) },
      });
    }
  }

  ws.currentRoomCode = null;
}

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🃏 DOSH Servidor Online (AUTORITATIVO) iniciado en el puerto ${PORT}`);
  console.log(`👉 Web local: http://localhost:${PORT}`);
  console.log(`===============================================`);
});
