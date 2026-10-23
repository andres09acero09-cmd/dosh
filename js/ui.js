/**
 * ui.js
 * Lógica de interfaz del juego DOS.
 *
 * Responsabilidades:
 *  - Navegar entre pantallas
 *  - Renderizar la configuración
 *  - Gestionar la fase de memoria (peek) con temporizador de 10 segundos
 *  - Renderizar la mesa de juego
 *
 * Depende de: deck.js, player.js, game.js
 */

// ─── Constantes ───────────────────────────────────────────────────────────────

const PEEK_SECONDS  = 10;
const SUIT_SYMBOLS  = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠', joker: '★' };
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Estado interno de la UI ─────────────────────────────────────────────────

const uiState = {
  peekTimer:          null,     // referencia al setInterval del countdown de memoria
  peekSecondsLeft:    0,
  peekActive:         false,    // true mientras corre el temporizador de memoria
  turnTimer:          null,     // referencia al setInterval de 30s por turno
  turnSecondsLeft:    30,       // segundos restantes en el turno actual
  turnMode:           'idle',   // 'idle' | 'replace' | 'match' | 'q_peek' | 'j_select_my' | 'j_select_target' | 'joker_red_select' | 'joker_black_select_player'
  jSelectedMySlot:    null,     // slot propio seleccionado al usar poder J
  lastPlayerIndex:    null,     // para detectar cambio de turno y reiniciar timer de 30s
  revealPhaseActive:  false,    // true durante la revelación final secuencial
  revealFinished:     false,    // true cuando todos los jugadores ya revelaron sus cartas
  revealOrder:        [],       // orden de índices de jugadores para revelar
  revealStep:         0,        // paso actual en revealOrder
  revealTimer:        null,     // temporizador de 5s para revelar
  revealSecondsLeft:  5,        // segundos restantes para el botón de revelar
  // ── Solo online (estado aplicado por el SERVIDOR autoritativo) ──
  pendingMode:        null,     // 'replace'|'match' a restaurar tras USE_TABLE
  qPeekPendingSlot:   null,     // slot cuya carta esperamos ver (poder Q)
  pendingMatchAnim:   null,     // {slotEl, slotIndex} para animar el resultado de copia
};

// ─── Navegación ───────────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function renderModeSelect() {
  stopTurnTimer();
  showScreen('screen-mode-select');
}

function renderOnlineScreen() {
  stopTurnTimer();
  showScreen('screen-online');
}

// ─── PANTALLA 1: Configuración ────────────────────────────────────────────────

function renderSetup() {
  stopTurnTimer();
  if (uiState.revealTimer) {
    clearInterval(uiState.revealTimer);
    uiState.revealTimer = null;
  }
  uiState.revealPhaseActive = false;
  uiState.revealFinished = false;
  uiState.revealOrder = [];
  uiState.revealStep = 0;
  showScreen('screen-setup');
  updatePlayerNameInputs();
}

/** Genera dinámicamente los campos de nombre según el contador actual. */
function updatePlayerNameInputs() {
  const count     = parseInt(document.getElementById('val-players').textContent);
  const container = document.getElementById('player-names');
  container.innerHTML = '';

  for (let i = 0; i < count; i++) {
    // Conservar el nombre que ya había escrito el jugador si existía
    const existing = document.getElementById(`player-name-${i}`);
    const savedVal = existing ? existing.value : `Jugador ${i + 1}`;

    const group = document.createElement('div');
    group.className = 'form-group';
    group.innerHTML = `
      <label>Nombre del jugador ${i + 1}</label>
      <input type="text" id="player-name-${i}"
             class="player-name-input"
             placeholder="Jugador ${i + 1}"
             value="${savedVal}">
    `;
    container.appendChild(group);
  }
}

/** Lee los valores del formulario y los devuelve. */
function getSetupValues() {
  const playerCount = parseInt(document.getElementById('val-players').textContent);
  const cardCount   = parseInt(document.getElementById('val-cards').textContent);
  const names = [];
  for (let i = 0; i < playerCount; i++) {
    const input = document.getElementById(`player-name-${i}`);
    names.push(input && input.value.trim() ? input.value.trim() : `Jugador ${i + 1}`);
  }
  return { playerCount, cardCount, names };
}

function showSetupError(msg) {
  const el = document.getElementById('setup-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearSetupError() {
  document.getElementById('setup-error').classList.add('hidden');
}

// ─── PANTALLA 2: Fase de memoria ──────────────────────────────────────────────

/**
 * Renderiza la pantalla de peek para el jugador actual.
 * Muestra sus cartas boca abajo y espera a que presione "¡Estoy listo!".
 */
function renderPeekScreen() {
  showScreen('screen-peek');
  _stopPeekTimer(); // por si hubiera uno activo
  uiState.peekActive = false;

  const gs      = Game.gameState;
  const peeker  = Game.getCurrentPeeker();

  // Si el peeker es un Bot, memoriza automáticamente sus cartas permitidas y avanza
  if (peeker && peeker.isBot) {
    const canSee = gs.cardsPerPlayer / 2;
    for (let i = 0; i < canSee; i++) {
      if (peeker.hand[i] && peeker.hand[i].card) {
        BotAI.recordCardInMemory(gs.peekPhase.currentPeekerIndex, i, peeker.hand[i].card);
      }
    }
    const result = Game.finishPeeking();
    if (result.peekPhaseEnded) {
      renderGameTable();
    } else {
      renderPeekScreen();
    }
    return;
  }

  const current = gs.peekPhase.currentPeekerIndex + 1;
  const total   = gs.players.length;
  const canSee  = gs.cardsPerPlayer / 2;

  // Textos
  el('peek-progress').textContent    = `Jugador ${current} de ${total}`;
  el('peek-player-name').textContent = peeker.name;
  el('peek-instruction').textContent =
    `Pasa el dispositivo a ${peeker.name}. Podrá ver ${canSee} de sus ${gs.cardsPerPlayer} cartas.`;

  // Cartas boca abajo (no seleccionables todavía)
  _renderPeekCards(peeker, false);

  // Botones
  show('btn-peek-ready');
  hide('btn-peek-done');
  hide('btn-peek-next');
  hide('peek-timer-container');
}

/**
 * Arranca el temporizador de 10 segundos y activa la selección de cartas.
 * Se llama cuando el jugador presiona "¡Estoy listo!".
 */
function startPeekTimer() {
  const peeker = Game.getCurrentPeeker();
  const canSee = Game.gameState.cardsPerPlayer / 2;

  uiState.peekActive      = true;
  uiState.peekSecondsLeft = PEEK_SECONDS;

  el('peek-instruction').textContent =
    `Toca hasta ${canSee} cartas para verlas. ¡Tienes ${PEEK_SECONDS} segundos!`;

  // Mostrar cartas seleccionables
  _renderPeekCards(peeker, true);

  // Mostrar timer y botón "Ya memoricé"
  show('peek-timer-container');
  show('btn-peek-done');
  hide('btn-peek-ready');
  hide('btn-peek-next');

  // Iniciar countdown
  _updateTimerDisplay();
  uiState.peekTimer = setInterval(() => {
    uiState.peekSecondsLeft--;
    _updateTimerDisplay();
    if (uiState.peekSecondsLeft <= 0) endPeekTurn();
  }, 1000);
}

/**
 * Termina el turno de peek del jugador actual (por tiempo o por elección).
 * Oculta las cartas y avanza al siguiente jugador (o inicia el juego).
 */
function endPeekTurn() {
  _stopPeekTimer();
  uiState.peekActive = false;

  // Ocultar cartas del jugador actual
  const peeker = Game.getCurrentPeeker();
  Player.hideAllCards(peeker);
  _renderPeekCards(peeker, false);

  // Avanzar en game.js
  const result = Game.finishPeeking();

  hide('btn-peek-done');
  hide('peek-timer-container');
  hide('btn-peek-ready');

  if (result.peekPhaseEnded) {
    // Todos terminaron — mostrar botón para comenzar
    el('peek-player-name').textContent = '¡Listos!';
    el('peek-instruction').textContent =
      'Todos los jugadores memorizaron sus cartas. ¡A jugar!';
    el('btn-peek-next').textContent    = '¡COMENZAR!';
  } else {
    // Siguiente jugador
    const next = Game.getCurrentPeeker();
    el('peek-instruction').textContent =
      `¡Tiempo! Pasa el dispositivo al siguiente jugador.`;
    el('btn-peek-next').textContent    = `SIGUIENTE: ${next.name} →`;
  }

  show('btn-peek-next');
}

/**
 * Fase de memoria exclusiva para partidas Online: cada jugador solo ve sus propias cartas en su pantalla
 */
function renderOnlinePeekScreen() {
  showScreen('screen-peek');
  _stopPeekTimer();
  uiState.peekActive = false;

  const gs = Game.gameState;
  const myPlayer = gs.players[gs.myPlayerIndex];
  const canSee = gs.cardsPerPlayer / 2;

  el('peek-progress').textContent = `Tu Mano (Jugador ${gs.myPlayerIndex + 1} de ${gs.players.length})`;
  el('peek-player-name').textContent = myPlayer.name;
  el('peek-instruction').textContent = `Presiona "¡ESTOY LISTO!" para memorizar ${canSee} de tus ${gs.cardsPerPlayer} cartas de forma privada.`;

  _renderPeekCards(myPlayer, false);

  show('btn-peek-ready');
  hide('btn-peek-done');
  hide('btn-peek-next');
  hide('peek-timer-container');
}

function startOnlinePeekTimer() {
  const gs = Game.gameState;
  const myPlayer = gs.players[gs.myPlayerIndex];
  const canSee = gs.cardsPerPlayer / 2;

  uiState.peekActive = true;
  uiState.peekSecondsLeft = PEEK_SECONDS;

  el('peek-instruction').textContent = `Toca hasta ${canSee} cartas para verlas. ¡Tienes ${PEEK_SECONDS} segundos!`;

  _renderPeekCards(myPlayer, true);

  show('peek-timer-container');
  show('btn-peek-done');
  hide('btn-peek-ready');
  hide('btn-peek-next');

  _updateTimerDisplay();
  uiState.peekTimer = setInterval(() => {
    uiState.peekSecondsLeft--;
    _updateTimerDisplay();
    if (uiState.peekSecondsLeft <= 0) endOnlinePeekTurn();
  }, 1000);
}

function endOnlinePeekTurn() {
  _stopPeekTimer();
  uiState.peekActive = false;

  const gs = Game.gameState;
  const myPlayer = gs.players[gs.myPlayerIndex];
  Player.hideAllCards(myPlayer);
  _renderPeekCards(myPlayer, false);

  hide('btn-peek-done');
  hide('peek-timer-container');
  hide('btn-peek-ready');
  hide('btn-peek-next');

  el('peek-player-name').textContent = '¡Cartas Memorizadas!';
  el('peek-instruction').textContent = '⏳ Esperando a que todos los jugadores terminen de memorizar para abrir la mesa...';

  // Notificar al servidor que este jugador terminó su fase de peek
  Network.sendGameAction('PEEK_DONE', {});
}

// Revela una carta durante el peek online: la identidad la autoriza el servidor
function applyPeekReveal(payload) {
  const gs = Game.gameState;
  if (!gs.isOnline || gs.gameStatus !== 'peeking') return;

  const { slotIndex, card } = payload;
  const myPlayer = gs.players[gs.myPlayerIndex];
  const slot = myPlayer.hand[slotIndex];
  if (!slot || !card) return;

  slot.card = card;
  slot.known = true;
  slot.faceUp = true;
  _renderPeekCards(myPlayer, true);

  const maxAllowed = gs.cardsPerPlayer / 2;
  const revealedCount = myPlayer.hand.filter(s => s.known).length;
  const left = maxAllowed - revealedCount;
  el('peek-instruction').textContent = left > 0
    ? `Toca una carta para verla. Te quedan ${left} por ver.`
    : '¡Ya viste todas tus cartas permitidas!';
}

/** El jugador toca una carta boca abajo para verla.  */
function _onPeekCardClick(slotIndex) {
  if (!uiState.peekActive) return;

  if (Game.gameState.isOnline) {
    const gs = Game.gameState;
    const myPlayer = gs.players[gs.myPlayerIndex];
    if (!myPlayer) return;
    const slot = myPlayer.hand[slotIndex];
    if (!slot || slot.card) return; // ya visible o desconocida pero pidiendo

    const maxAllowed = gs.cardsPerPlayer / 2;
    const revealedCount = myPlayer.hand.filter(s => s.known).length;
    if (revealedCount >= maxAllowed) return;

    // El servidor valida el límite y responde SOLO a este cliente con la identidad
    Network.sendGameAction('PEEK_REVEAL', { slotIndex });
    return;
  }

  const result = Game.peekCard(slotIndex);
  if (!result.success) return;

  // Re-renderizar con el estado actualizado
  const peeker = Game.getCurrentPeeker();
  _renderPeekCards(peeker, true);

  const left = Game.getCardsLeftToPeek();
  el('peek-instruction').textContent =
    left > 0
      ? `Toca una carta para verla. Te quedan ${left} por ver.`
      : '¡Ya viste todas tus cartas permitidas!';
}

/** Renderiza las cartas del jugador en la pantalla de peek. */
function _renderPeekCards(player, selectable) {
  const container = el('peek-cards');
  container.innerHTML = '';
  player.hand.forEach((slot, index) => {
    container.appendChild(_buildCardEl(slot, index, selectable));
  });
}

/** Actualiza la barra y número del temporizador. */
function _updateTimerDisplay() {
  const s   = uiState.peekSecondsLeft;
  const pct = (s / PEEK_SECONDS) * 100;

  el('peek-timer-text').textContent    = s;
  el('peek-timer-bar').style.width     = `${pct}%`;

  const bar = el('peek-timer-bar');
  bar.className = s <= 3 ? 'timer-bar danger'
                : s <= 5 ? 'timer-bar warning'
                : 'timer-bar';
}

function _stopPeekTimer() {
  if (uiState.peekTimer) { clearInterval(uiState.peekTimer); uiState.peekTimer = null; }
}

// ─── PANTALLA 3: Mesa de juego ────────────────────────────────────────────────

async function renderGameTable() {
  // Asegurar que todas las cartas de todos los jugadores estén estrictamente boca abajo
  if (Game.gameState && Game.gameState.players) {
    Game.gameState.players.forEach(p => {
      Player.hideAllCards(p);
    });
  }

  showScreen('screen-game');
  uiState.turnMode = 'idle';
  updateTurnUI();

  // Animación de barajar las cartas directamente en el mazo sobre la mesa
  await Anim.shuffleDeckOnTable();
}

function updateTurnUI() {
  const gs = Game.gameState;

  if (gs.gameStatus === 'ended') {
    stopTurnTimer();
    hide('turn-timer-container');
    renderPlayers();
    renderDeck();
    renderTableCard();

    // Si aún no se ha completado la revelación secuencial, iniciarla
    if (!uiState.revealFinished) {
      if (!uiState.revealPhaseActive) {
        startSequentialRevealPhase();
      }
      return;
    }

    _updateActionArea();
    showGameOverModal();
    return;
  }

  // Si cambió de jugador en su turno, sincronizar el temporizador con el SERVIDOR
  if (uiState.lastPlayerIndex !== gs.currentPlayerIndex && (gs.gameStatus === 'playing' || gs.gameStatus === 'dosh')) {
    uiState.lastPlayerIndex = gs.currentPlayerIndex;
    if (gs.isOnline) {
      // Online: el SERVIDOR es la única autoridad del tiempo.
      // Aquí solo se muestra la cuenta atrás que él envió (sin decidir nada).
      syncTurnTimerDisplay(gs.turnSecondsLeft != null ? gs.turnSecondsLeft : TURN_SECONDS);
    } else {
      startTurnTimer();
    }
  }

  // Sincronizar automáticamente el modo de interacción antes de renderizar
  if (gs.pendingDiscardPower) {
    if (gs.pendingDiscardPower.type === 'JOKER_RED') {
      uiState.turnMode = 'joker_red_select';
    } else if (gs.pendingDiscardPower.type === 'JOKER_BLACK') {
      uiState.turnMode = 'joker_black_select_player';
    }
  } else if (gs.drawnCard && gs.drawnCard.rank === 'JOKER') {
    if (gs.drawnCard.color === 'red') {
      uiState.turnMode = 'joker_red_select';
    } else if (gs.drawnCard.color === 'black') {
      uiState.turnMode = 'joker_black_select_player';
    }
  }

  renderPlayers();
  renderDeck();
  renderTableCard();
  _updateActionArea();

  // Si el jugador actual es un bot, ejecutar su turno automáticamente (SOLO MODO LOCAL)
  // En online los bots los ejecuta el SERVIDOR con la misma IA (bot.js).
  if (!gs.isOnline && (gs.gameStatus === 'playing' || gs.gameStatus === 'dosh')) {
    const activeP = gs.players[gs.currentPlayerIndex];
    if (activeP && activeP.isBot && !isBotTurnRunning) {
      setTimeout(() => {
        _runBotTurn(gs.currentPlayerIndex);
      }, 500);
    }
  }
}

function renderPlayers() {
  const gs = Game.gameState;
  const container = el('players-area');
  container.innerHTML = '';

  const activeIndex = gs.currentPlayerIndex;

  gs.players.forEach((player, pIndex) => {
    const area = document.createElement('div');
    area.className = 'player-area';
    area.id        = `player-${pIndex}`;
    if (pIndex === activeIndex && (gs.gameStatus === 'playing' || gs.gameStatus === 'dosh')) {
      area.classList.add('active-player');
    }

    const isMe = gs.isOnline && pIndex === gs.myPlayerIndex;
    if (isMe) {
      area.classList.add('my-player');
      area.style.border = '2px solid #20c997';
      area.style.borderRadius = '12px';
    }

    const nameDiv = document.createElement('div');
    nameDiv.className = 'player-name';
    if (player.isBot) {
      nameDiv.innerHTML = `🤖 ${player.name} <span class="player-tag bot">BOT</span>`;
    } else if (isMe) {
      nameDiv.innerHTML = `👤 ${player.name} <span class="player-tag you">TÚ</span>`;
    } else {
      nameDiv.textContent = player.name;
    }

    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'player-cards';

    player.hand.forEach((slot, sIndex) => {
      let isTarget = false;
      let targetClick = null;
      let extraClass = '';

      // En modo Online, solo se pueden seleccionar cartas si es el turno de MI jugador
      const canInteract = !gs.isOnline || (gs.currentPlayerIndex === gs.myPlayerIndex);

      if (canInteract) {
        if (pIndex === activeIndex) {
          // Carta del jugador activo
          if (uiState.turnMode === 'replace') {
            isTarget = true;
            targetClick = () => _onSlotReplaceClick(sIndex);
          } else if (uiState.turnMode === 'match') {
            isTarget = true;
            targetClick = () => _onSlotMatchClick(sIndex);
          } else if (uiState.turnMode === 'q_peek') {
            isTarget = true;
            targetClick = () => _onSlotQPeekClick(sIndex);
          } else if (uiState.turnMode === 'j_select_my') {
            isTarget = true;
            extraClass = 'j-target-my';
            targetClick = () => _onSlotJSelectMyClick(sIndex);
          } else if (uiState.turnMode === 'joker_red_select') {
            isTarget = true;
            extraClass = 'j-target-my';
            targetClick = () => _onSlotJokerRedClick(sIndex);
          }
        } else {
          // Carta de un rival: seleccionable para poder J (Paso 2) o Joker Negro
          if (uiState.turnMode === 'j_select_target') {
            isTarget = true;
            extraClass = 'j-target-other';
            targetClick = () => _onSlotJSelectTargetClick(pIndex, sIndex);
          } else if (uiState.turnMode === 'joker_black_select_player') {
            isTarget = true;
            extraClass = 'j-target-other';
            targetClick = () => _onSelectJokerBlackTarget(pIndex);
          }
        }
      }

      cardsDiv.appendChild(_buildCardEl(slot, sIndex, false, isTarget, targetClick, extraClass));
    });

    const countDiv = document.createElement('div');
    countDiv.className   = 'player-card-count';
    countDiv.textContent = `${player.hand.length} carta${player.hand.length !== 1 ? 's' : ''}`;

    area.appendChild(nameDiv);
    area.appendChild(cardsDiv);
    area.appendChild(countDiv);
    container.appendChild(area);
  });
}

function renderDeck() {
  const gs = Game.gameState;
  el('deck-count').textContent = `${gs.deck.length}`;
  const deckEl = el('deck-pile');

  // Permitir voltear carta haciendo clic en el mazo SOLO si es mi turno, no hay carta volteada y en modo idle
  const canDraw = (gs.gameStatus === 'playing' || gs.gameStatus === 'dosh')
    && uiState.turnMode === 'idle'
    && !gs.drawnCard
    && gs.deck.length > 0
    && (!gs.isOnline || gs.currentPlayerIndex === gs.myPlayerIndex);

  if (canDraw) {
    deckEl.classList.add('can-draw');
    deckEl.onclick = _onDrawCardClick;
  } else {
    deckEl.classList.remove('can-draw');
    deckEl.onclick = null;
  }
}

/** Renderiza la carta descubierta en la mesa con las cartas anteriores asomadas por un lado */
function renderTableCard() {
  const gs = Game.gameState;
  const holder = el('drawn-card-slot');
  if (!holder) return;

  const topCard = gs.drawnCard || gs.activeTableCard;

  if (!topCard) {
    holder.className = 'discard-placeholder';
    holder.innerHTML = '<span>VACÍO</span>';
    return;
  }

  // Obtenemos las cartas previas del historial (las que están debajo de la principal)
  // Excluimos la carta superior actual y las repetidas (mismo id) para no duplicarlas
  const seenIds = new Set();
  const previousCards = (gs.tableHistory || []).filter(c => {
    if (!c) return false;
    if (topCard.id && c.id) {
      if (c.id === topCard.id) return false;
      if (seenIds.has(c.id)) return false;
      seenIds.add(c.id);
      return true;
    }
    return !(c.rank === topCard.rank && c.suit === topCard.suit);
  });

  // Tomamos hasta las 2 cartas inmediatamente anteriores
  const underCards = previousCards.slice(-2);

  holder.className = 'table-card-stack';
  holder.innerHTML = '';

  // 1. Si hay 2 cartas previas, la más profunda (under-2)
  if (underCards.length === 2) {
    const cardDeep = underCards[0];
    const sym = SUIT_SYMBOLS[cardDeep.suit];
    const elDeep = document.createElement('div');
    elDeep.className = `card face-up ${cardDeep.color} under-2`;
    elDeep.innerHTML = `
      <span class="card-corner top">${cardDeep.rank}${sym}</span>
      <span class="card-center">${sym}</span>
      <span class="card-corner bottom">${cardDeep.rank}${sym}</span>
    `;
    holder.appendChild(elDeep);
  }

  // 2. La carta inmediatamente anterior debajo (under-1)
  if (underCards.length >= 1) {
    const cardMid = underCards[underCards.length - 1];
    const sym = SUIT_SYMBOLS[cardMid.suit];
    const elMid = document.createElement('div');
    elMid.className = `card face-up ${cardMid.color} under-1`;
    elMid.innerHTML = `
      <span class="card-corner top">${cardMid.rank}${sym}</span>
      <span class="card-center">${sym}</span>
      <span class="card-corner bottom">${cardMid.rank}${sym}</span>
    `;
    holder.appendChild(elMid);
  }

  // 3. La carta superior activa (arriba del todo)
  const symTop = SUIT_SYMBOLS[topCard.suit];
  const elTop = document.createElement('div');
  elTop.className = `card face-up ${topCard.color} top-card drawn-active`;
  elTop.innerHTML = `
    <span class="card-corner top">${topCard.rank}${symTop}</span>
    <span class="card-center">${symTop}</span>
    <span class="card-corner bottom">${topCard.rank}${symTop}</span>
  `;
  holder.appendChild(elTop);
}

function _updateActionArea() {
  const gs = Game.gameState;
  const actContainer = el('action-buttons');
  actContainer.innerHTML = '';

  if (gs.gameStatus === 'ended') {
    stopTurnTimer();
    hide('turn-timer-container');
    setGameStatus('PARTIDA FINALIZADA');
    const btn = document.createElement('button');
    btn.className = 'btn-primary';
    btn.textContent = 'NUEVA PARTIDA';
    btn.onclick = () => { hide('modal-game-over'); renderSetup(); };
    actContainer.appendChild(btn);
    return;
  }

  const current = Game.getCurrentPlayer();
  const statusText = gs.gameStatus === 'dosh'
    ? `Turno de ${current.name} (ÚLTIMA RONDA — ${gs.lastRoundTurnsLeft} turno${gs.lastRoundTurnsLeft !== 1 ? 's' : ''} restante${gs.lastRoundTurnsLeft !== 1 ? 's' : ''})`
    : `Turno de ${current.name}`;
  setGameStatus(statusText);

  // Si el turno actual es de un Bot, mostrar mensaje informativo y ocultar botones interactivos humanos
  if (current && current.isBot) {
    const botBanner = document.createElement('div');
    botBanner.className = 'bot-indicator-banner';
    botBanner.style.cssText = 'padding: 12px 18px; font-weight: bold; color: #a5d8ff; font-size: 1.1rem; background: rgba(24, 100, 171, 0.25); border-radius: 8px; border: 1px solid #339af0;';
    botBanner.innerHTML = `🤖 <em>${current.name}</em> está jugando su turno...`;
    actContainer.appendChild(botBanner);
    return;
  }

  // Si estamos en modo Online y NO es mi turno ni es turno de bot
  if (gs.isOnline && gs.currentPlayerIndex !== gs.myPlayerIndex && !current.isBot) {
    actContainer.innerHTML = '';
    const rivalBanner = document.createElement('div');
    rivalBanner.className = 'rival-turn-banner';
    rivalBanner.style.cssText = 'padding: 14px 20px; font-weight: bold; color: #ffd43b; font-size: 1.15rem; background: rgba(0, 0, 0, 0.45); border-radius: 10px; border: 2px dashed #ffd43b; text-align: center; margin: 10px 0;';
    rivalBanner.innerHTML = `⏳ Es el turno de <strong>${current.name}</strong>. Esperando su jugada...`;
    actContainer.appendChild(rivalBanner);
    setGameMessage(`Turno de ${current.name}. Esperando su jugada...`, 'info');
    return;
  }

  // ── CASO A: PODERES PENDIENTES TRAS BOTAR CARTA EN UN CAMBIO (Q, J, Jokers) ──
  if (gs.pendingDiscardPower) {
    const pPower = gs.pendingDiscardPower;

    if (pPower.type === 'JOKER_RED') {
      if (uiState.turnMode !== 'joker_red_select') {
        uiState.turnMode = 'joker_red_select';
        renderPlayers(); // Re-renderizar para que las cartas sean clickeables
      }
      setGameMessage(`🔥 ¡${current.name} botó el Joker Rojo! Es OBLIGATORIO usar su poder: toca una carta de TU baraja para botarla a la mesa (quedará encima del Joker Rojo):`, 'warning');
      // No hay botón cancelar: los Jokers son obligatorios
      return;
    }

    if (pPower.type === 'JOKER_BLACK') {
      uiState.turnMode = 'joker_black_select_player';
      setGameMessage(`⚡ ¡${current.name} botó el Joker Negro! Es OBLIGATORIO usar su poder: elige a qué rival castigar (+2 cartas del mazo y le pasas el turno):`, 'warning');
      gs.players.forEach((p, idx) => {
        if (idx !== gs.currentPlayerIndex) {
          const btnTarget = document.createElement('button');
          btnTarget.className = 'btn-primary';
          btnTarget.style.background = 'linear-gradient(135deg, #495057, #1a1a1a)';
          btnTarget.textContent = `🎯 Castigar a ${p.name}`;
          btnTarget.onclick = () => _onSelectJokerBlackTarget(idx);
          actContainer.appendChild(btnTarget);
        }
      });
      // No hay botón cancelar: los Jokers son obligatorios
      return;
    }

    if (pPower.type === 'Q') {
      if (uiState.turnMode === 'q_peek') {
        setGameMessage('👁 PODER DE LA Q: Toca la carta de TU baraja que deseas ver por 5 segundos.', 'warning');
        const btnSkip = document.createElement('button');
        btnSkip.className = 'btn-secondary';
        btnSkip.textContent = 'TERMINAR TURNO (NO VER CARTA)';
        btnSkip.onclick = () => _onSkipPendingPowerClick();
        actContainer.appendChild(btnSkip);
        return;
      }

      setGameMessage(`👁 ¡${current.name} botó una Q! Puedes usar su poder para ver una carta de tu baraja por 5 segundos, o terminar tu turno:`, 'info');
      const btnQ = document.createElement('button');
      btnQ.className = 'btn-primary btn-power-q';
      btnQ.textContent = '👁 VER CARTA (Q)';
      btnQ.onclick = () => { uiState.turnMode = 'q_peek'; updateTurnUI(); };
      actContainer.appendChild(btnQ);

      const btnEnd = document.createElement('button');
      btnEnd.className = 'btn-secondary';
      btnEnd.textContent = 'TERMINAR TURNO';
      btnEnd.onclick = () => _onSkipPendingPowerClick();
      actContainer.appendChild(btnEnd);
      return;
    }

    if (pPower.type === 'J') {
      if (uiState.turnMode === 'j_select_my') {
        setGameMessage('🔄 PODER DE LA J (Paso 1): Toca una de TUS cartas para intercambiar.', 'warning');
        const btnSkip = document.createElement('button');
        btnSkip.className = 'btn-secondary';
        btnSkip.textContent = 'TERMINAR TURNO';
        btnSkip.onclick = () => _onSkipPendingPowerClick();
        actContainer.appendChild(btnSkip);
        return;
      }

      if (uiState.turnMode === 'j_select_target') {
        setGameMessage('🔄 PODER DE LA J (Paso 2): Ahora toca una carta de OTRO JUGADOR para intercambiarla.', 'warning');
        const btnSkip = document.createElement('button');
        btnSkip.className = 'btn-secondary';
        btnSkip.textContent = 'TERMINAR TURNO';
        btnSkip.onclick = () => _onSkipPendingPowerClick();
        actContainer.appendChild(btnSkip);
        return;
      }

      setGameMessage(`🔄 ¡${current.name} botó una J! Puedes usar su poder para intercambiar una carta con un rival (boca abajo), o terminar tu turno:`, 'info');
      const btnJ = document.createElement('button');
      btnJ.className = 'btn-primary btn-power-j';
      btnJ.textContent = '🔄 INTERCAMBIAR (J)';
      btnJ.onclick = () => { uiState.turnMode = 'j_select_my'; updateTurnUI(); };
      actContainer.appendChild(btnJ);

      const btnEnd = document.createElement('button');
      btnEnd.className = 'btn-secondary';
      btnEnd.textContent = 'TERMINAR TURNO';
      btnEnd.onclick = () => _onSkipPendingPowerClick();
      actContainer.appendChild(btnEnd);
      return;
    }
  }

  // ── CASO B: JOKERS VOLTEADOS DEL MAZO (ESTRICTAMENTE OBLIGATORIOS) ──
  // Nota: la detección se hace aquí pero el renderPlayers ya se ejecutó antes con el modo correcto
  if (gs.drawnCard && gs.drawnCard.rank === 'JOKER') {
    if (gs.drawnCard.color === 'red') {
      // Si aun no estamos en modo joker_red_select, establecerlo y volver a renderizar
      if (uiState.turnMode !== 'joker_red_select') {
        uiState.turnMode = 'joker_red_select';
        renderPlayers(); // Re-renderizar para que las cartas sean clickeables
      }
      setGameMessage(`🔥 ¡${current.name} sacó el Joker Rojo del mazo! Es OBLIGATORIO usar su poder: toca una carta de TU baraja para botarla a la mesa (quedará encima del Joker Rojo):`, 'warning');
      return;
    } else {
      uiState.turnMode = 'joker_black_select_player';
      setGameMessage(`⚡ ¡${current.name} sacó el Joker Negro del mazo! Es OBLIGATORIO usar su poder: elige a qué rival castigar (+2 cartas del mazo y le pasas el turno):`, 'warning');
      gs.players.forEach((p, idx) => {
        if (idx !== gs.currentPlayerIndex) {
          const btnTarget = document.createElement('button');
          btnTarget.className = 'btn-primary';
          btnTarget.style.background = 'linear-gradient(135deg, #495057, #1a1a1a)';
          btnTarget.textContent = `🎯 Castigar a ${p.name}`;
          btnTarget.onclick = () => _onSelectJokerBlackTarget(idx);
          actContainer.appendChild(btnTarget);
        }
      });
      return;
    }
  }

  // ── Modos especiales en curso de cartas volteadas del mazo ──
  if (uiState.turnMode === 'q_peek') {
    setGameMessage('👁 PODER DE LA Q: Toca una de TUS cartas para verla por 5 segundos.', 'warning');
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-secondary';
    btnCancel.textContent = 'CANCELAR';
    btnCancel.onclick = _onCancelAction;
    actContainer.appendChild(btnCancel);
    return;
  }

  if (uiState.turnMode === 'j_select_my') {
    setGameMessage('🔄 PODER DE LA J (Paso 1): Toca una de TUS cartas para intercambiar.', 'warning');
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-secondary';
    btnCancel.textContent = 'CANCELAR';
    btnCancel.onclick = _onCancelAction;
    actContainer.appendChild(btnCancel);
    return;
  }

  if (uiState.turnMode === 'j_select_target') {
    setGameMessage('🔄 PODER DE LA J (Paso 2): Ahora toca una carta de OTRO JUGADOR para intercambiarla.', 'warning');
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-secondary';
    btnCancel.textContent = 'CANCELAR';
    btnCancel.onclick = () => { uiState.jSelectedMySlot = null; _onCancelAction(); };
    actContainer.appendChild(btnCancel);
    return;
  }

  // ── Función helper para añadir botones de poderes (Q, J) solo para carta robada del mazo ──
  function _appendPowerButtons() {
    if (gs.drawnCard && gs.drawnCard.rank === 'Q') {
      const btnQ = document.createElement('button');
      btnQ.className = 'btn-secondary btn-power-q';
      btnQ.textContent = '👁 VER CARTA (Q)';
      btnQ.onclick = () => { uiState.turnMode = 'q_peek'; updateTurnUI(); };
      actContainer.appendChild(btnQ);
    }

    if (gs.drawnCard && gs.drawnCard.rank === 'J' && gs.jPowerUsable) {
      const btnJ = document.createElement('button');
      btnJ.className = 'btn-secondary btn-power-j';
      btnJ.textContent = '🔄 INTERCAMBIAR (J)';
      btnJ.onclick = () => { uiState.turnMode = 'j_select_my'; updateTurnUI(); };
      actContainer.appendChild(btnJ);
    }
  }

  // ── Botón DOSH: ÚNICAMENTE visible antes de comenzar a jugar su turno ──
  function _appendDoshButton() {
    if (gs.doshAnnouncedBy === null && !gs.drawnCard && uiState.turnMode === 'idle' && !gs.tableCardMatchedThisTurn && !gs.pendingDiscardPower && !gs.qChainActive) {
      const btnDosh = document.createElement('button');
      btnDosh.className = 'btn-primary btn-dosh';
      btnDosh.textContent = '¡DOSH!';
      btnDosh.onclick = _onDoshClick;
      actContainer.appendChild(btnDosh);
    }
  }

  // CASO 1: No hay carta en juego todavía (ni volteada del mazo en este turno)
  if (!gs.drawnCard) {

    // ── SUB-CASO: Cadena de la Q activa (el jugador anterior usó la Q) ──
    // Este jugador puede ver una carta (opcional), o rechazar rompiendo la cadena
    if (gs.qChainActive && gs.activeTableCard && gs.activeTableCard.rank === 'Q') {
      if (uiState.turnMode === 'q_peek') {
        setGameMessage('👁 PODER DE LA Q EN CADENA: Toca una de TUS cartas para verla por 5 segundos.', 'warning');
        const btnSkip = document.createElement('button');
        btnSkip.className = 'btn-secondary';
        btnSkip.textContent = 'NO VER (Rompe la cadena)';
        btnSkip.onclick = () => _onBreakQChainClick();
        actContainer.appendChild(btnSkip);
        return;
      }

      setGameMessage(`👁 ¡CADENA DE Q! ¿Quieres ver una de tus cartas por 5 segundos? Si no ves, la cadena se rompe.`, 'info');
      const btnSeeCard = document.createElement('button');
      btnSeeCard.className = 'btn-primary btn-power-q';
      btnSeeCard.textContent = '👁 VER CARTA (Q)';
      btnSeeCard.onclick = () => { uiState.turnMode = 'q_peek'; updateTurnUI(); };
      actContainer.appendChild(btnSeeCard);

      const btnNoSee = document.createElement('button');
      btnNoSee.className = 'btn-secondary';
      btnNoSee.textContent = 'NO VER (Rompe la cadena)';
      btnNoSee.onclick = () => _onBreakQChainClick();
      actContainer.appendChild(btnNoSee);
      return;
    }

    if (gs.activeTableCard) {
      const tableLabel = Deck.getCardLabel(gs.activeTableCard);
      const isTableJoker = gs.activeTableCard.rank === 'JOKER';

      // SUB-CASO: Ya hizo copia con la de la mesa en este turno -> solo puede voltear del mazo
      if (gs.tableCardMatchedThisTurn) {
        setGameMessage(`¡Copia exitosa! Continúa tu turno: debes voltear una carta del mazo (no puedes cambiar la carta que acabas de emparejar):`, 'info');
        const btnDraw = document.createElement('button');
        btnDraw.className = 'btn-primary';
        btnDraw.textContent = 'VOLTEAR DEL MAZO';
        btnDraw.onclick = _onDrawCardClick;
        actContainer.appendChild(btnDraw);
        return;
      }

      if (uiState.turnMode === 'idle') {
        if (isTableJoker) {
          setGameMessage(`En la mesa está ${tableLabel} (dejado anteriormente). Los Jokers de la mesa NO se pueden cambiar. Debes voltear del mazo o hacer copia:`, 'warning');
        } else {
          setGameMessage(`En la mesa está ${tableLabel} (dejada anteriormente). Puedes usarla, o voltear una nueva del mazo si no te sirve:`, 'info');
        }

        // Botón: Voltear del mazo
        const btnDraw = document.createElement('button');
        btnDraw.className = 'btn-primary';
        btnDraw.textContent = 'VOLTEAR DEL MAZO';
        btnDraw.onclick = _onDrawCardClick;
        actContainer.appendChild(btnDraw);

        // Botón: Cambiarla (Jokers NO se pueden cambiar)
        if (!isTableJoker) {
          const btnReplace = document.createElement('button');
          btnReplace.className = 'btn-secondary';
          btnReplace.textContent = 'CAMBIARLA';
          btnReplace.onclick = _onStartReplaceTableClick;
          actContainer.appendChild(btnReplace);
        }

        // Botón: Hacer copia (usando la de la mesa)
        const btnMatch = document.createElement('button');
        btnMatch.className = 'btn-secondary';
        btnMatch.textContent = 'HACER COPIA';
        btnMatch.onclick = _onStartMatchTableClick;
        actContainer.appendChild(btnMatch);

        // Botón: Dejarla (pasar turno manteniendo la carta)
        const btnLeave = document.createElement('button');
        btnLeave.className = 'btn-secondary';
        btnLeave.textContent = 'DEJARLA';
        btnLeave.onclick = _onPassTurnClick;
        actContainer.appendChild(btnLeave);

        _appendDoshButton();

      } else if (uiState.turnMode === 'replace') {
        setGameMessage(`Toca cualquiera de tus cartas para cambiarla por el ${tableLabel} de la mesa.`, 'warning');
        const btnCancel = document.createElement('button');
        btnCancel.className = 'btn-secondary';
        btnCancel.textContent = 'CANCELAR';
        btnCancel.onclick = _onCancelAction;
        actContainer.appendChild(btnCancel);

      } else if (uiState.turnMode === 'match') {
        setGameMessage(`Toca la carta de tu baraja que crees que es un ${tableLabel}. Si aciertas se reduce; si fallas te comes una del mazo sin ver.`, 'warning');
        const btnCancel = document.createElement('button');
        btnCancel.className = 'btn-secondary';
        btnCancel.textContent = 'CANCELAR';
        btnCancel.onclick = _onCancelAction;
        actContainer.appendChild(btnCancel);
      }

    } else {
      // Mesa vacía (inicio de partida) -> debe voltear del mazo
      setGameMessage(`Es el turno de ${current.name}. Voltea una carta del mazo.`, 'info');
      const btnDraw = document.createElement('button');
      btnDraw.className = 'btn-primary';
      btnDraw.textContent = 'VOLTEAR DEL MAZO';
      btnDraw.onclick = _onDrawCardClick;
      actContainer.appendChild(btnDraw);

      _appendDoshButton();
    }

  } else {
    // CASO 2: El jugador acaba de voltear una carta del mazo en este turno (no Joker, pues los Jokers ya retornaron antes)
    const drawnLabel = Deck.getCardLabel(gs.drawnCard);

    if (uiState.turnMode === 'idle') {
      setGameMessage(`${current.name} volteó ${drawnLabel} del mazo. Elige tu acción:`, 'info');

      // 1. Dejarla
      const btnDiscard = document.createElement('button');
      btnDiscard.className = 'btn-secondary';
      btnDiscard.textContent = 'DEJARLA';
      btnDiscard.onclick = _onDiscardClick;
      actContainer.appendChild(btnDiscard);

      // 2. Cambiarla
      const btnReplace = document.createElement('button');
      btnReplace.className = 'btn-primary';
      btnReplace.textContent = 'CAMBIARLA';
      btnReplace.onclick = _onStartReplaceClick;
      actContainer.appendChild(btnReplace);

      // 3. Hacer copia
      const btnMatch = document.createElement('button');
      btnMatch.className = 'btn-primary';
      btnMatch.textContent = 'HACER COPIA';
      btnMatch.onclick = _onStartMatchClick;
      actContainer.appendChild(btnMatch);

      _appendPowerButtons();

    } else if (uiState.turnMode === 'replace') {
      setGameMessage(`Toca cualquiera de tus cartas para cambiarla por el ${drawnLabel}. La carta que saques quedará en la mesa.`, 'warning');
      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn-secondary';
      btnCancel.textContent = 'CANCELAR';
      btnCancel.onclick = _onCancelAction;
      actContainer.appendChild(btnCancel);

    } else if (uiState.turnMode === 'match') {
      setGameMessage(`Toca la carta de tu baraja que crees que es un ${drawnLabel}. Si aciertas se reduce; si fallas te comes una carta del mazo sin ver.`, 'warning');
      const btnCancel = document.createElement('button');
      btnCancel.className = 'btn-secondary';
      btnCancel.textContent = 'CANCELAR';
      btnCancel.onclick = _onCancelAction;
      actContainer.appendChild(btnCancel);
    }
  }
}

// ─── Controladores de acción del turno ────────────────────────────────────────

async function _onDrawCardClick() {
  const gs = Game.gameState;

  // ONLINE: el servidor ejecuta y responde con el estado; la animación llega al aplicar STATE
  if (gs.isOnline) {
    Network.sendGameAction('DRAW');
    return;
  }

  const result = Game.drawCardForCurrentPlayer();
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }

  // Si se reconstituyó el mazo con las cartas de la mesa
  if (result.reshuffled) {
    await Anim.toast('🔀 ¡Cartas agotadas! Rebarajando las cartas de la mesa...', 'warning', 2200);
    await Anim.shuffleDeckOnTable();
  }

  // Carta vuela del mazo con flip 3D mostrando su cara al llegar
  await Anim.drawFromDeck(result.card);

  if (result.card.rank === 'JOKER') {
    uiState.turnMode = result.card.color === 'red' ? 'joker_red_select' : 'joker_black_select_player';
  } else {
    uiState.turnMode = 'idle';
  }
  updateTurnUI();
}

function _onStartReplaceTableClick() {
  const gs = Game.gameState;
  if (gs.isOnline) {
    uiState.pendingMode = 'replace';
    Network.sendGameAction('USE_TABLE');
    return;
  }

  const result = Game.useTableCardForCurrentPlayer();
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }
  uiState.turnMode = 'replace';
  updateTurnUI();
}

function _onStartMatchTableClick() {
  const gs = Game.gameState;
  if (gs.isOnline) {
    uiState.pendingMode = 'match';
    Network.sendGameAction('USE_TABLE');
    return;
  }

  const result = Game.useTableCardForCurrentPlayer();
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }
  uiState.turnMode = 'match';
  updateTurnUI();
}

function _onPassTurnClick() {
  const gs = Game.gameState;
  const currentName = Game.getCurrentPlayer().name;

  if (gs.isOnline) {
    Network.sendGameAction('PASS_TURN');
    return;
  }

  if (gs.qChainActive) {
    Game.breakQChain();
  }
  Game.nextTurn();
  uiState.turnMode = 'idle';

  setGameMessage(`${currentName} decidió dejar la carta en la mesa. Le toca al siguiente jugador.`, 'info');
  updateTurnUI();
}

async function _onDiscardClick() {
  const gs = Game.gameState;
  const currentName = Game.getCurrentPlayer().name;

  if (gs.isOnline) {
    // El fx (landFromDeck) revela la carta volando del mazo para las demás pantallas;
    // en la mía ya estaba visible: solo el estado la pasa a CARTA EN MESA
    Network.sendGameAction('DISCARD');
    return;
  }

  const result = Game.discardDrawnCard();
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }

  uiState.turnMode = 'idle';
  setGameMessage(`${currentName} dejó la carta en la mesa para el siguiente jugador.`, 'info');
  Anim.tableLand();
  updateTurnUI();
}

function _onStartReplaceClick() {
  uiState.turnMode = 'replace';
  updateTurnUI();
}

function _onStartMatchClick() {
  uiState.turnMode = 'match';
  updateTurnUI();
}

function _onCancelAction() {
  const gs = Game.gameState;

  if (gs.isOnline) {
    if (gs.pendingDiscardPower && (gs.pendingDiscardPower.type === 'Q' || gs.pendingDiscardPower.type === 'J')) {
      Network.sendGameAction('SKIP_PENDING_POWER');
    }
    uiState.turnMode = 'idle';
    uiState.jSelectedMySlot = null;
    return;
  }

  if (gs.pendingDiscardPower) {
    if (gs.pendingDiscardPower.type === 'Q' || gs.pendingDiscardPower.type === 'J') {
      Game.skipPendingPower();
    }
  } else if (gs.activeTableCard === gs.drawnCard) {
    gs.drawnCard = null;
  }
  uiState.turnMode = 'idle';
  uiState.jSelectedMySlot = null;
  updateTurnUI();
}

function _onSkipPendingPowerClick() {
  const gs = Game.gameState;

  if (gs.isOnline) {
    uiState.turnMode = 'idle';
    uiState.jSelectedMySlot = null;
    Network.sendGameAction('SKIP_PENDING_POWER');
    return;
  }

  Game.skipPendingPower();
  uiState.turnMode = 'idle';
  uiState.jSelectedMySlot = null;
  updateTurnUI();
}

function _onBreakQChainClick() {
  const gs = Game.gameState;

  if (gs.isOnline) {
    uiState.turnMode = 'idle';
    Network.sendGameAction('BREAK_Q_CHAIN');
    return;
  }

  Game.breakQChain();
  Game.nextTurn();
  uiState.turnMode = 'idle';
  updateTurnUI();
}

async function _onSlotReplaceClick(slotIndex) {
  const gs = Game.gameState;
  const currentName = Game.getCurrentPlayer().name;

  // ONLINE: el servidor ejecuta; el fx del STATE anima el vuelo para TODAS las pantallas
  if (gs.isOnline) {
    uiState.turnMode = 'idle';
    Network.sendGameAction('REPLACE', { slotIndex });
    return;
  }

  const playerIndex = gs.currentPlayerIndex;

  // Capturar DOM y datos de carta ANTES de mutar el estado
  const playerArea = el(`player-${playerIndex}`);
  const cardEls    = playerArea ? playerArea.querySelectorAll('.card') : [];
  const slotEl     = cardEls[slotIndex] || null;
  const slot       = Game.getCurrentPlayer().hand[slotIndex];
  const cardData   = slot ? slot.card : null;

  // Carta vuela de la mano a la mesa (boca arriba si la conocíamos, boca abajo si no)
  if (slotEl) await Anim.flyCardToTable(slotEl, cardData);

  const result = Game.replaceCardWithDrawn(slotIndex);
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }

  // Si la carta botada activa un poder
  if (result.pendingPower === 'JOKER_RED') {
    uiState.turnMode = 'joker_red_select';
    await Anim.toast('🔥 ¡Botaste el Joker Rojo! Obligatorio botar otra carta a la mesa', 'warning', 2200);
    updateTurnUI();
    return;
  }

  if (result.pendingPower === 'JOKER_BLACK') {
    uiState.turnMode = 'joker_black_select_player';
    await Anim.toast('⚡ ¡Botaste el Joker Negro! Obligatorio castigar a un rival (+2)', 'warning', 2200);
    updateTurnUI();
    return;
  }

  if (result.pendingPower === 'Q') {
    uiState.turnMode = 'idle';
    await Anim.toast('👁 ¡Botaste una Q! Puedes ver una de tus cartas', 'info', 1800);
    updateTurnUI();
    return;
  }

  if (result.pendingPower === 'J') {
    uiState.turnMode = 'idle';
    await Anim.toast('🔄 ¡Botaste una J! Puedes intercambiar una carta', 'info', 1800);
    updateTurnUI();
    return;
  }

  uiState.turnMode = 'idle';
  setGameMessage(`${currentName} cambió una carta. El ${Deck.getCardLabel(result.oldCard)} quedó en la mesa.`, 'success');
  Anim.toast('♻ Cambio realizado', 'success', 1200);
  updateTurnUI();
}

async function _onSlotMatchClick(slotIndex) {
  const gs = Game.gameState;
  const current = Game.getCurrentPlayer();
  const playerIndex = gs.currentPlayerIndex;

  if (gs.isOnline) {
    // El fx del STATE anima el vuelo, el brillo y (si falla) la penalización en TODAS las pantallas
    uiState.turnMode = 'idle';
    Network.sendGameAction('MATCH', { slotIndex });
    return;
  }

  // Capturar DOM y datos de la carta elegida ANTES de mutar el estado
  const playerArea = el(`player-${playerIndex}`);
  const cardEls    = playerArea ? playerArea.querySelectorAll('.card') : [];
  const slotEl     = cardEls[slotIndex] || null;
  const slot       = current.hand[slotIndex];
  const cardData   = slot ? slot.card : null;

  const result = Game.matchCardWithDrawn(slotIndex);
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }

  uiState.turnMode = 'idle';

  if (result.matched) {
    // ✅ COPIA CORRECTA: carta vuela a la mesa y desaparece con brillo verde
    if (slotEl) await Anim.flyCardToTable(slotEl, cardData);
    if (slotEl) await Anim.copySuccess(slotEl, cardData);

    if (result.gameEnded) {
      await Anim.toast(`🏆 ¡${result.winner.name} gana la partida!`, 'success', 2500);
      setGameStatus('¡PARTIDA TERMINADA!');
      setGameMessage(`¡${result.winner.name} se quedó con 0 cartas y GANA LA PARTIDA!`, 'success');
      updateTurnUI();
      return;
    }

    if (result.drawnFromTable) {
      await Anim.toast('✅ ¡Copia correcta! Sigue tu turno', 'success', 1600);
      setGameMessage(
        `¡Copia correcta! ${current.name} eliminó su ${Deck.getCardLabel(result.removedCard)} y ahora le quedan ${current.hand.length}. Sigue siendo su turno.`,
        'success'
      );
    } else {
      const next = Game.getCurrentPlayer();
      await Anim.toast('✅ ¡Copia correcta!', 'success', 1400);
      setGameMessage(
        `¡Copia correcta! ${current.name} eliminó su ${Deck.getCardLabel(result.removedCard)} y ahora le quedan ${current.hand.length}. Turno de ${next.name}.`,
        'success'
      );
    }

  } else {
    // ❌ COPIA INCORRECTA: carta se revela, se sacude en rojo, vuelve. Luego penalización vuela.
    await Anim.copyFail(slotEl, result.revealedCard);

    if (result.penaltyCard && playerArea) {
      await Anim.penaltyFly(playerArea);
    }

    if (result.drawnFromTable) {
      await Anim.toast(`❌ ¡No era igual! Era un ${Deck.getCardLabel(result.revealedCard)}. +1 carta. Sigue tu turno`, 'error', 2200);
      setGameMessage(
        `¡No era igual! Era un ${Deck.getCardLabel(result.revealedCard)}. Te comes una carta del mazo sin ver. Ahora tienes ${current.hand.length}. Sigue siendo tu turno.`,
        'error'
      );
    } else {
      const next = Game.getCurrentPlayer();
      await Anim.toast(`❌ ¡No era igual! Era un ${Deck.getCardLabel(result.revealedCard)}. +1 carta`, 'error', 2200);
      setGameMessage(
        `¡No era igual! Era un ${Deck.getCardLabel(result.revealedCard)}. Te comes una carta sin ver. Ahora tienes ${current.hand.length}. Turno de ${next.name}.`,
        'error'
      );
    }
  }

  updateTurnUI();
}

function setGameStatus(msg) {
  el('game-status').textContent = msg;
}

function setGameMessage(msg, type = 'info') {
  const div = el('game-message');
  div.textContent = msg;
  div.className   = `game-message ${type}`;
}

// ─── Construcción de elementos de carta ──────────────────────────────────────

/**
 * Construye y devuelve un elemento <div> de carta.
 *
 * @param {Object}  slot           - Slot de la mano del jugador
 * @param {number}  slotIndex      - Posición en la mano
 * @param {boolean} selectable     - Si se puede tocar para revelar (solo en peek)
 * @param {boolean} isActionTarget - Si puede ser seleccionada para acción (reemplazar/emparejar)
 * @param {Function} onActionClick - Función a ejecutar al hacer clic
 * @returns {HTMLDivElement}
 */
function _buildCardEl(slot, slotIndex, selectable, isActionTarget = false, onActionClick = null, extraClass = '') {
  const div = document.createElement('div');
  div.dataset.slot = slotIndex;

  if (slot.faceUp && slot.card) {
    // ── Carta visible ──
    const sym = SUIT_SYMBOLS[slot.card.suit];
    div.className = `card face-up ${slot.card.color}`;
    div.innerHTML = `
      <span class="card-corner top">${slot.card.rank}${sym}</span>
      <span class="card-center">${sym}</span>
      <span class="card-corner bottom">${slot.card.rank}${sym}</span>
    `;
  } else {
    // ── Carta boca abajo ──
    div.className = 'card face-down';
    if (selectable) {
      let canClick = false;
      if (Game.gameState.isOnline) {
        // Online: el límite de cartas a mirar lo valida el servidor
        canClick = !slot.card;
      } else {
        canClick = Game.gameState.peekPhase.cardsLeftToReveal > 0
          && !Game.gameState.peekPhase.revealedThisPeek.includes(slotIndex);
      }
      if (canClick) {
        div.classList.add('selectable');
        div.addEventListener('click', () => _onPeekCardClick(slotIndex));
      }
    }
  }

  if (isActionTarget && onActionClick) {
    div.classList.add('action-target');
    if (extraClass) div.classList.add(extraClass);
    div.addEventListener('click', onActionClick);
  }

  return div;
}

// ─── Temporizador de Turno (30 segundos) ──────────────────────────────────────

const TURN_SECONDS = 30;

function startTurnTimer() {
  stopTurnTimer();
  uiState.turnSecondsLeft = TURN_SECONDS;
  _updateTurnTimerDisplay();
  show('turn-timer-container');

  uiState.turnTimer = setInterval(() => {
    uiState.turnSecondsLeft--;
    _updateTurnTimerDisplay();
    if (uiState.turnSecondsLeft <= 0) {
      stopTurnTimer();
      _onTurnTimeout();
    }
  }, 1000);
}

/**
 * ONLINE: muestra la cuenta atrás que envía el servidor SIN decidir nada.
 * El vencimiento (acciones) lo ejecuta únicamente el servidor.
 */
function syncTurnTimerDisplay(seconds) {
  stopTurnTimer();
  uiState.turnSecondsLeft = seconds;
  _updateTurnTimerDisplay();
  show('turn-timer-container');

  uiState.turnTimer = setInterval(() => {
    uiState.turnSecondsLeft = Math.max(0, uiState.turnSecondsLeft - 1);
    _updateTurnTimerDisplay();
  }, 1000);
}

function stopTurnTimer() {
  if (uiState.turnTimer) {
    clearInterval(uiState.turnTimer);
    uiState.turnTimer = null;
  }
}

function _updateTurnTimerDisplay() {
  const secs = uiState.turnSecondsLeft;
  const pct  = (secs / TURN_SECONDS) * 100;
  const bar  = el('turn-timer-bar');
  const valE = el('turn-timer-val');
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.classList.remove('warning', 'danger');
    if (secs <= 8) bar.classList.add('danger');
    else if (secs <= 15) bar.classList.add('warning');
  }
  if (valE) valE.textContent = `${secs}s`;
}

/**
 * SOLO MODO LOCAL: venció el temporizador del navegador.
 * En online el timeout lo ejecuta exclusivamente el SERVIDOR
 * (scheduleTurnTimer en server.js) y llega vía STATE.
 */
function _onTurnTimeout() {
  const gs = Game.gameState;
  if (gs.isOnline) { // Nunca debe llamarse en online, pero lo blindamos
    return;
  }

  const currentName = Game.getCurrentPlayer().name;

  if (gs.pendingDiscardPower) {
    if (gs.pendingDiscardPower.type === 'Q' || gs.pendingDiscardPower.type === 'J') {
      Game.skipPendingPower();
    } else if (gs.pendingDiscardPower.type === 'JOKER_RED') {
      Game.useJokerRedPower(0);
    } else if (gs.pendingDiscardPower.type === 'JOKER_BLACK') {
      const nextIdx = (gs.currentPlayerIndex + 1) % gs.players.length;
      Game.useJokerBlackPower(nextIdx);
    }
  } else if (gs.drawnCard && gs.drawnCard.rank === 'JOKER') {
    if (gs.drawnCard.color === 'red') {
      Game.useJokerRedPower(0);
    } else {
      const nextIdx = (gs.currentPlayerIndex + 1) % gs.players.length;
      Game.useJokerBlackPower(nextIdx);
    }
  } else if (gs.drawnCard) {
    Game.discardDrawnCard();
  } else {
    Game.nextTurn();
  }

  uiState.turnMode = 'idle';
  uiState.jSelectedMySlot = null;
  Anim.toast(`⏱ ¡Se acabó el tiempo (30s) de ${currentName}!`, 'warning', 1800);

  updateTurnUI();
}

// ─── Handlers de Poder Q (Ver carta propia por 5 segundos) ────────────────────

async function _onSlotQPeekClick(slotIndex) {
  const gs = Game.gameState;
  const myPlayer = gs.players[gs.myPlayerIndex];
  const slot = myPlayer ? myPlayer.hand[slotIndex] : null;

  // ONLINE: el servidor autoriza y ejecuta; al llegar el STATE mostramos la carta 5s
  if (gs.isOnline) {
    if (!slot) return;
    uiState.qPeekPendingSlot = slotIndex;
    Network.sendGameAction('USE_Q_PEEK', { slotIndex });
    return;
  }

  const current = Game.getCurrentPlayer();
  const currentName = current.name;

  if (!slot || !slot.card) return;

  uiState.turnMode = 'idle';
  stopTurnTimer();

  slot.faceUp = true;
  renderPlayers();

  const cardLabel = Deck.getCardLabel(slot.card);

  // Ver durante 5 segundos con cuenta atrás visible
  for (let s = 5; s >= 1; s--) {
    setGameMessage(`👁 Viendo tu carta (${cardLabel}): ${s} segundo${s !== 1 ? 's' : ''}...`, 'info');
    await _sleep(1000);
  }

  // Voltear la carta nuevamente boca abajo
  slot.faceUp = false;
  renderPlayers();

  // Aplicar el efecto de la Q en la lógica del juego (avanza turno)
  const result = Game.useQPower(slotIndex);
  if (!result.success) {
    setGameMessage(result.error, 'error');
  }

  updateTurnUI();
}

// ─── Handlers de Poder J (Intercambiar cartas con animación boca abajo) ───────

function _onSlotJSelectMyClick(slotIndex) {
  uiState.jSelectedMySlot = slotIndex;
  uiState.turnMode = 'j_select_target';
  updateTurnUI();
}

async function _onSlotJSelectTargetClick(targetPlayerIndex, targetSlotIndex) {
  const gs = Game.gameState;
  const mySlot = uiState.jSelectedMySlot;
  if (mySlot === null) return;

  const currentPlayer = Game.getCurrentPlayer();
  const targetPlayer  = gs.players[targetPlayerIndex];
  const currentName   = currentPlayer.name;
  const targetName    = targetPlayer.name;

  const playerAreaA = el(`player-${gs.currentPlayerIndex}`);
  const playerAreaB = el(`player-${targetPlayerIndex}`);
  const cardElsA    = playerAreaA ? playerAreaA.querySelectorAll('.card') : [];
  const cardElsB    = playerAreaB ? playerAreaB.querySelectorAll('.card') : [];
  const slotElA     = cardElsA[mySlot] || null;
  const slotElB     = cardElsB[targetSlotIndex] || null;

  // ONLINE: el servidor autoriza e intercambia de verdad;
  // el fx del STATE anima el cruce de las dos cartas en TODAS las pantallas
  if (gs.isOnline) {
    uiState.jSelectedMySlot = null;
    uiState.turnMode = 'idle';
    Network.sendGameAction('USE_J_SWAP', { mySlot, targetPlayerIndex, targetSlotIndex });
    return;
  }

  const result = Game.useJPower(mySlot, targetPlayerIndex, targetSlotIndex);
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }

  uiState.jSelectedMySlot = null;
  uiState.turnMode = 'idle';

  await Anim.toast(`🔄 ¡${currentName} intercambió una carta con ${targetName}!`, 'info', 1800);
  updateTurnUI();
}

// ─── Handlers de Poder Joker Rojo (Botar carta de su baraja a la mesa) ────────

async function _onSlotJokerRedClick(slotIndex) {
  const gs = Game.gameState;
  const currentName = Game.getCurrentPlayer().name;
  const playerIndex = gs.currentPlayerIndex;

  // ONLINE: el servidor autoriza; el fx del STATE anima el vuelo en todas las pantallas
  if (gs.isOnline) {
    uiState.turnMode = 'idle';
    Network.sendGameAction('USE_JOKER_RED', { slotIndex });
    return;
  }

  const playerArea = el(`player-${playerIndex}`);
  const cardEls    = playerArea ? playerArea.querySelectorAll('.card') : [];
  const slotEl     = cardEls[slotIndex] || null;
  const slot       = Game.getCurrentPlayer().hand[slotIndex];
  const cardData   = slot ? slot.card : null;

  if (slotEl) await Anim.flyCardToTable(slotEl, cardData);

  const result = Game.useJokerRedPower(slotIndex);
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }

  uiState.turnMode = 'idle';
  await Anim.toast(`🔥 ¡${currentName} botó una carta con el Joker Rojo!`, 'success', 2200);

  if (result.gameEnded) {
    await Anim.toast(`🏆 ¡${result.winner.name} se quedó sin cartas y GANA!`, 'success', 2500);
  }

  updateTurnUI();
}

// ─── Handlers de Poder Joker Negro (Castigar a rival con 2 cartas) ───────────

async function _onSelectJokerBlackTarget(targetPlayerIndex) {
  const gs = Game.gameState;
  const currentName  = Game.getCurrentPlayer().name;
  const targetPlayer = gs.players[targetPlayerIndex];

  // ONLINE: el servidor autoriza; el fx del STATE anima el castigo en todas las pantallas
  if (gs.isOnline) {
    uiState.turnMode = 'idle';
    Network.sendGameAction('USE_JOKER_BLACK', { targetPlayerIndex });
    return;
  }

  const targetArea = el(`player-${targetPlayerIndex}`);
  if (targetArea) {
    await Anim.penaltyFly(targetArea);
  }

  const result = Game.useJokerBlackPower(targetPlayerIndex);
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }

  uiState.turnMode = 'idle';
  await Anim.toast(`⚡ ¡${currentName} castigó a ${targetPlayer.name} (+2 cartas)! Turno de ${targetPlayer.name}`, 'warning', 2600);

  updateTurnUI();
}

// ─── Handler de DOSH ──────────────────────────────────────────────────────────

async function _onDoshClick() {
  const gs = Game.gameState;

  // ONLINE: el servidor autoriza el canto de DOSH
  if (gs.isOnline) {
    Network.sendGameAction('ANNOUNCE_DOSH');
    return;
  }

  const result = Game.announceDosh();
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }

  await Anim.toast(`🔥 ¡${result.player.name} CANTÓ DOSH! Juega tu turno y luego comenzará la última ronda para los demás.`, 'warning', 3000);
  updateTurnUI();
}

// ─── Fase de Revelación Final Secuencial (Jugador por Jugador) ────────────────

function startSequentialRevealPhase() {
  uiState.revealPhaseActive = true;
  uiState.revealFinished    = false;
  stopTurnTimer();
  hide('turn-timer-container');

  const gs = Game.gameState;
  const numPlayers = gs.players.length;

  // Orden circular empezando por el jugador siguiente a donde acabó la partida
  // "ejemplo, acabo en el jugador 1, el jugador 2 revela sus cartas con su puntaje total, luego el jugador 3 y así sucesivamente"
  const lastIdx = gs.currentPlayerIndex;
  const order = [];
  for (let i = 1; i <= numPlayers; i++) {
    order.push((lastIdx + i) % numPlayers);
  }

  uiState.revealOrder = order;
  uiState.revealStep  = 0;

  _runNextRevealStep();
}

function _runNextRevealStep() {
  const gs = Game.gameState;

  if (uiState.revealStep >= uiState.revealOrder.length) {
    uiState.revealPhaseActive = false;
    uiState.revealFinished    = true;
    updateTurnUI();
    showGameOverModal();
    return;
  }

  const pIndex = uiState.revealOrder[uiState.revealStep];
  const player = gs.players[pIndex];
  uiState.revealSecondsLeft = 5;

  setGameStatus(`FASE FINAL: REVELANDO CARTAS (${uiState.revealStep + 1}/${uiState.revealOrder.length})`);
  setGameMessage(`Turno de revelar cartas: ${player.name}. Tienes 5 segundos:`, 'warning');

  // Resaltar visualmente el área del jugador que está revelando
  document.querySelectorAll('.player-area').forEach((pa, idx) => {
    pa.classList.toggle('active-player', idx === pIndex);
  });

  const actContainer = el('action-buttons');
  actContainer.innerHTML = '';

  const btnReveal = document.createElement('button');
  btnReveal.className = 'btn-primary btn-reveal-cards';
  btnReveal.style.background = 'linear-gradient(135deg, #7048e8, #f59f00)';
  btnReveal.style.fontSize = '1.05rem';
  btnReveal.style.padding = '12px 24px';
  btnReveal.textContent = `👁 REVELAR CARTAS (${uiState.revealSecondsLeft}s)`;

  let triggered = false;
  const executeReveal = async () => {
    if (triggered) return;
    triggered = true;
    if (uiState.revealTimer) {
      clearInterval(uiState.revealTimer);
      uiState.revealTimer = null;
    }
    btnReveal.disabled = true;

    // 1. Revelar todas las cartas de este jugador
    player.hand.forEach(slot => {
      if (slot && slot.card) {
        slot.faceUp = true;
        slot.known = true;
        if (slot.card) slot.card.faceUp = true;
      }
    });

    // 2. Calcular puntaje total de este jugador
    let totalScore = 0;
    player.hand.forEach(slot => {
      if (slot && slot.card) {
        totalScore += (typeof Rules !== 'undefined' && Rules.getCardValue)
          ? Rules.getCardValue(slot.card)
          : 0;
      }
    });

    renderPlayers();

    await Anim.toast(`🃏 ${player.name} reveló sus cartas: Total = ${totalScore} pts`, 'info', 2200);
    await _sleep(1800);

    uiState.revealStep++;
    _runNextRevealStep();
  };

  btnReveal.onclick = executeReveal;
  actContainer.appendChild(btnReveal);

  if (player.isBot) {
    setTimeout(() => {
      executeReveal();
    }, 1500);
  } else {
    // Iniciar timer regresivo de 5 segundos para jugadores humanos
    uiState.revealTimer = setInterval(() => {
      uiState.revealSecondsLeft--;
      if (uiState.revealSecondsLeft > 0) {
        btnReveal.textContent = `👁 REVELAR CARTAS (${uiState.revealSecondsLeft}s)`;
      } else {
        executeReveal();
      }
    }, 1000);
  }
}

// ─── Lógica y Ejecución de Turnos de Bots (IA) ───────────────────────────────

let isBotTurnRunning = false;

async function _runBotTurn(botIndex) {
  if (isBotTurnRunning) return;
  const gs = Game.gameState;
  const bot = gs.players[botIndex];
  if (!bot || !bot.isBot) return;

  // ONLINE: los bots los ejecuta el SERVIDOR (misma IA, bot.js); nunca el navegador
  if (gs.isOnline) return;

  isBotTurnRunning = true;
  try {
    setGameMessage(`🤖 ${bot.name} está pensando su jugada...`, 'info');

    await BotAI.playTurn(botIndex, gs, {
      announceDosh: () => {
        _onDoshClick();
      },
      useQPeek: async (slotIdx) => {
        await _onSlotQPeekClick(slotIdx);
      },
      matchWithTable: async (slotIdx) => {
        _onStartMatchTableClick();
        await _sleep(500);
        await _onSlotMatchClick(slotIdx);
      },
      replaceWithTable: async (slotIdx) => {
        _onStartReplaceTableClick();
        await _sleep(500);
        await _onSlotReplaceClick(slotIdx);
      },
      drawFromDeck: async () => {
        await _onDrawCardClick();
      },
      useJokerRed: async (slotIdx) => {
        await _onSlotJokerRedClick(slotIdx);
      },
      useJokerBlack: async (targetRivalIdx) => {
        await _onSelectJokerBlackTarget(targetRivalIdx);
      },
      useJSwap: async (mySlot, rivalIdx, rivalSlot) => {
        _onSlotJSelectMyClick(mySlot);
        await _sleep(500);
        await _onSlotJSelectTargetClick(rivalIdx, rivalSlot);
      },
      matchWithDrawn: async (slotIdx) => {
        _onStartMatchClick();
        await _sleep(500);
        await _onSlotMatchClick(slotIdx);
      },
      replaceWithDrawn: async (slotIdx) => {
        _onStartReplaceClick();
        await _sleep(500);
        await _onSlotReplaceClick(slotIdx);
      },
      discardDrawn: async () => {
        await _onDiscardClick();
      }
    });
  } catch (err) {
    console.error('Error ejecutando turno de bot:', err);
  } finally {
    isBotTurnRunning = false;
  }
}

/**
 * Inicia una partida online multijugador.
 * El SERVIDOR es quien baraja, reparte y ejecuta la lógica.
 * Aquí solo preparamos la vista local (caché de estado) con las cartas vacías,
 * porque la información privada se solicitará al servidor con PEEK_REVEAL.
 */
function startOnlineGame(players, cardsPerPlayer) {
  stopTurnTimer();
  if (uiState.revealTimer) {
    clearInterval(uiState.revealTimer);
    uiState.revealTimer = null;
  }
  uiState.revealPhaseActive = false;
  uiState.revealFinished = false;
  uiState.revealOrder = [];
  uiState.revealStep = 0;
  uiState.lastPlayerIndex = null;
  uiState.pendingMode = null;
  uiState.qPeekPendingSlot = null;

  const gs = Game.gameState;
  const myId = Network.getMyPlayerId();
  const myIndex = players.findIndex(p => p.id === myId);
  if (myIndex === -1) {
    console.error('No se pudo identificar a este jugador en la lista:', myId, players);
    Anim.toast('Error: no se pudo identificar tu jugador en la sala.', 'error', 4000);
  }
  gs.myPlayerIndex = myIndex !== -1 ? myIndex : 0;
  uiState.myPlayerIndex = gs.myPlayerIndex;

  // Reconstruir la caché de estado local (SOLO INTERFAZ; la verdad vivirá en el servidor)
  gs.playerCount       = players.length;
  gs.cardsPerPlayer    = cardsPerPlayer;
  gs.isOnline          = true;
  gs.players           = [];
  gs.deck              = [];
  gs.discardPile       = [];
  gs.tableHistory      = [];
  gs.activeTableCard   = null;
  gs.drawnCard         = null;
  gs.drawnFromTable    = false;
  gs.doshAnnouncedBy   = null;
  gs.lastRoundTurnsLeft = 0;
  gs.doshAnnouncerPlayedTurn = false;
  gs.pendingDiscardPower = null;
  gs.qChainActive      = false;
  gs.qOriginPlayerIndex = null;
  gs.jPowerUsable      = false;
  gs.jokerBlackBlocked = false;
  gs.tableCardMatchedThisTurn = false;
  gs.currentPlayerIndex = 0;
  gs.turnId            = 0;
  gs.gameStatus        = 'peeking';

  players.forEach((p, idx) => {
    const pl = Player.createPlayer(idx, p.name);
    pl.isBot = !!p.isBot;
    // Slots vacíos: la identidad de cada carta se revela SOLO a su dueño vía PEEK_REVEALED
    pl.hand = [];
    for (let i = 0; i < cardsPerPlayer; i++) {
      pl.hand.push({ card: null, known: false, faceUp: false });
    }
    gs.players.push(pl);
  });

  renderOnlinePeekScreen();
}

/**
 * Aplica el estado filtrado que envía el servidor (vista pública + vista privada).
 * El cliente NO ejecuta ninguna regla: solo refleja lo que el servidor decidió.
 * Los estados llegan en ráfaga (varios actions seguidos de bots): se encolan
 * aquí para que las animaciones nunca se solapen.
 */
let _applyStateQueue = Promise.resolve();

function applyServerState(payload) {
  _applyStateQueue = _applyStateQueue
    .then(() => _applyServerStateInner(payload))
    .catch(e => console.error('Error aplicando estado del servidor:', e));
  return _applyStateQueue;
}

async function _applyServerStateInner(payload) {
  const gs = Game.gameState;
  const pub = payload.public;
  const priv = payload.private || {};

  const prevPhase       = gs.gameStatus;
  const prevDrawnCard   = gs.drawnCard;
  const wasRevealFinished = uiState.revealFinished;
  const prevCurrentPlayer = gs.currentPlayerIndex;

  // El SERVIDOR es la autoridad sobre quién es este cliente
  if (typeof priv.myIndex === 'number') {
    gs.myPlayerIndex = priv.myIndex;
    uiState.myPlayerIndex = priv.myIndex;
  }

  // ── Actualizar los datos de vista ──
  gs.cardsPerPlayer = pub.cardsPerPlayer;
  gs.gameStatus     = pub.phase;
  gs.currentPlayerIndex = pub.currentPlayerIndex;
  gs.turnId         = pub.turnId;
  gs.turnSecondsLeft = pub.turnSecondsLeft;
  gs.deck           = new Array(pub.deckCount);
  gs.tableHistory   = (pub.tableHistory || []).slice();
  gs.activeTableCard = pub.activeTableCard;
  gs.drawnCard      = priv.myDrawnCard || pub.drawnCard || null; // REGLA: la carta robada del mazo es pública (todos la ven)
  gs.drawnFromTable = false;
  gs.doshAnnouncedBy = pub.doshAnnouncedBy;
  gs.lastRoundTurnsLeft = pub.lastRoundTurnsLeft;
  gs.pendingDiscardPower = pub.pendingPowerType ? { type: pub.pendingPowerType, card: null } : null;
  gs.qChainActive   = pub.qChainActive;
  gs.jokerBlackBlocked = pub.jokerBlackBlocked;
  gs.tableCardMatchedThisTurn = pub.tableCardMatchedThisTurn;
  gs.jPowerUsable   = pub.jPowerUsable;

  // Reconstruir jugadores y manos (mis manos con mi vista privada; rivales solo cantidad)
  const newPlayers = [];
  pub.players.forEach((pInfo, idx) => {
    const pl = Player.createPlayer(idx, pInfo.name);
    pl.isBot = !!pInfo.isBot;
    pl.penaltyCount = pInfo.penaltyCount || 0;
    pl.hand = [];

    if (pub.ended && pInfo.hand) {
      // Partida terminada: el servidor revela TODAS las manos a todos
      pInfo.hand.forEach(slData => {
        pl.hand.push({ card: slData.card, known: true, faceUp: true });
      });
    } else if (idx === priv.myIndex) {
      priv.myHand.forEach(slData => {
        pl.hand.push({ card: slData.card || null, known: !!slData.known, faceUp: !!slData.faceUp });
      });
    } else {
      for (let i = 0; i < pInfo.handCount; i++) {
        pl.hand.push({ card: null, known: false, faceUp: false });
      }
    }
    newPlayers.push(pl);
  });
  gs.players = newPlayers;
  gs.playerCount = newPlayers.length;

  // ── Animaciones: TODOS los clientes ejecutan el mismo fx del servidor ──
  // (vuelos, cruces de intercambio, penalizaciones) + voltee del mazo por aviso.
  const noticeText = (payload.personal && payload.personal.text)
    || (pub.notice && pub.notice.text) || '';
  const drewCardForMe = priv.myDrawnCard || pub.drawnCard || null;
  await _runActionAnimations(noticeText, drewCardForMe, payload).catch(() => {});

  // ── Respiro al CAMBIAR de turno: que todos vean a quién le toca ──
  if (pub.currentPlayerIndex !== prevCurrentPlayer
      && (pub.phase === 'playing' || pub.phase === 'dosh')) {
    await _sleep(700);
  }

  // ── Normalización del modo de interacción (mata los modos fantasma) ──
  // Solo se permiten modos que el estado actual justifica; si no, se limpian.
  const isMyTurn = gs.currentPlayerIndex === gs.myPlayerIndex;
  const myDrawn = priv.myDrawnCard || pub.drawnCard || null;
  const pendingType = gs.pendingDiscardPower ? gs.pendingDiscardPower.type : null;
  const canPeekQ = pendingType === 'Q'
    || (isMyTurn && myDrawn && myDrawn.rank === 'Q')
    || (gs.qChainActive && gs.activeTableCard && gs.activeTableCard.rank === 'Q');
  const canUseJ = pendingType === 'J'
    || (isMyTurn && myDrawn && myDrawn.rank === 'J' && gs.jPowerUsable);
  const canJokerRed = pendingType === 'JOKER_RED'
    || (isMyTurn && myDrawn && myDrawn.rank === 'JOKER' && myDrawn.color === 'red');
  const canJokerBlack = pendingType === 'JOKER_BLACK'
    || (isMyTurn && myDrawn && myDrawn.rank === 'JOKER' && myDrawn.color === 'black');

  if (uiState.pendingMode && isMyTurn) {
    uiState.turnMode = uiState.pendingMode;   // p.ej. 'replace'/'match' tras tomarse la carta de la mesa
    uiState.pendingMode = null;
  } else if (uiState.pendingMode && !isMyTurn) {
    uiState.pendingMode = null;
  } else if (!isMyTurn) {
    uiState.turnMode = 'idle';
    uiState.jSelectedMySlot = null;
  }

  let _modeInvalid = false;
  if (uiState.turnMode === 'q_peek' && !canPeekQ) _modeInvalid = true;
  if ((uiState.turnMode === 'j_select_my' || uiState.turnMode === 'j_select_target') && !canUseJ) _modeInvalid = true;
  if (uiState.turnMode === 'joker_red_select' && !canJokerRed) _modeInvalid = true;
  if (uiState.turnMode === 'joker_black_select_player' && !canJokerBlack) _modeInvalid = true;
  if (_modeInvalid) {
    uiState.turnMode = 'idle';
    uiState.jSelectedMySlot = null;
  }

  // ── Mensajes: primero lo personal, si no el aviso público ──
  if (payload.personal && payload.personal.text) {
    setGameMessage(payload.personal.text, payload.personal.type || 'info');
  } else if (pub.notice && pub.notice.text) {
    setGameMessage(pub.notice.text, pub.notice.type || 'info');
  }

  // Poder Q pendiente de mostrar mi carta 5 segundos
  if (uiState.qPeekPendingSlot !== null) {
    const slotIdx = uiState.qPeekPendingSlot;
    uiState.qPeekPendingSlot = null;
    const slot = gs.players[gs.myPlayerIndex].hand[slotIdx];
    if (slot && slot.known) {
      _animateQPeekViewing(slotIdx, slot.card);
    }
  }

  // ── Transiciones de pantalla ──
  if (gs.gameStatus === 'peeking') {
    if (prevPhase !== 'peeking' || !document.getElementById('screen-peek').classList.contains('active')) {
      renderOnlinePeekScreen();
    }
    return;
  }

  if (prevPhase === 'peeking' && (gs.gameStatus === 'playing' || gs.gameStatus === 'dosh')) {
    uiState.lastPlayerIndex = null;
    await renderGameTable();
    return;
  }

  if (gs.gameStatus === 'ended') {
    // Online: no hay revelación secuencial local (el servidor ya reveló todo)
    uiState.revealPhaseActive = false;
    uiState.revealFinished = true;
    updateTurnUI();
    showGameOverModal(pub.scoreResults);
    return;
  }

  updateTurnUI();
}

/**
 * Animaciones de las jugadas. Dos fuentes:
 *  1. `fx` del servidor (payload.public.fx): la MISMA animación en TODAS las pantallas:
 *     - land: la carta que sale de la mano vuela a la mesa (cambio, copia, Joker Rojo)
 *             — incluye el REVELADO de cartas que acaban de ser públicas
 *     - landFromDeck: la carta robada descartada se revela volando del mazo (para los demás)
 *     - swap: intercambio J cruzando las dos cartas boca abajo
 *     - penalty: cartas de castigo/penalización volando hacia el afectado
 *  2. El aviso del voltee del mazo: mi carta boca arriba; la de otros, boca abajo.
 */
async function _runActionAnimations(text, drawnCardForMe, payload = {}) {
  const gs = Game.gameState;
  const pub = payload.public || {};
  const fx = pub.fx || null;

  // ── Voltee del mazo: REGLA → la carta es PÚBLICA, todos la ven revelarse ──
  if (text) {
    const mineDraw = /^Volteaste .+? del mazo/.test(text);
    const otherDraw = !mineDraw && /volteó una carta del mazo/.test(text);
    if (mineDraw && drawnCardForMe) {
      await Anim.drawFromDeck(drawnCardForMe).catch(() => {});
    } else if (otherDraw && pub.drawnCard) {
      await Anim.drawFromDeck(pub.drawnCard).catch(() => {});
    }
  }

  if (!fx) return;

  // ── Intercambio J: la misma animación en todas las pantallas ──
  if (fx.swap) {
    const areaA = el(`player-${fx.swap.ap}`);
    const areaB = el(`player-${fx.swap.bp}`);
    const slotElA = areaA ? areaA.querySelector(`.card[data-slot="${fx.swap.as}"]`) : null;
    const slotElB = areaB ? areaB.querySelector(`.card[data-slot="${fx.swap.bs}"]`) : null;
    if (slotElA && slotElB) {
      await _sleep(450); // respiro para que todos procesen qué cartas se cruzan
      await Anim.swapCardsBetweenSlots(slotElA, slotElB, null, null).catch(() => {});
    }
    return;
  }

  // ── Carta que sale de la mano y aterriza en la mesa (cambio / copia / Joker Rojo) ──
  if (fx.land) {
    const area = el(`player-${fx.land.p}`);
    const slotEl = area ? area.querySelector(`.card[data-slot="${fx.land.s}"]`) : null;
    if (slotEl) {
      // La carta ya es pública (quedó en la mesa): vuela mostrando su cara para TODOS
      await Anim.flyCardToTable(slotEl, fx.land.card || null).catch(() => {});
    } else {
      Anim.tableLand();
    }
    return;
  }

  // ── Penalización / castigo (+1 o +2 cartas) hacia el afectado ──
  if (fx.penalty) {
    const area = el(`player-${fx.penalty.p}`);
    if (area) await Anim.penaltyFly(area).catch(() => {});
    return;
  }
}

/** Muestra mi carta durante 5 segundos (poder de la Q) y la vuelve a ocultar. */
async function _animateQPeekViewing(slotIdx, cardData) {  const gs = Game.gameState;
  const myPlayer = gs.players[gs.myPlayerIndex];
  const slot = myPlayer.hand[slotIdx];
  if (!slot) return;

  const cardLabel = cardData ? Deck.getCardLabel(cardData) : '?';

  slot.faceUp = true;
  renderPlayers();

  for (let s = 5; s >= 1; s--) {
    setGameMessage(`👁 Viendo tu carta (${cardLabel}): ${s} segundo${s !== 1 ? 's' : ''}...`, 'info');
    await _sleep(1000);
  }

  slot.faceUp = false;
  renderPlayers();
}

// ─── Modal de Fin de Partida ──────────────────────────────────────────────────

/**
 * Modal de fin de partida.
 * ONLINE: los resultados los calcula el SERVIDOR y llegan en `results`
 * ({name, score, isWinner, hand:[card,...]} por jugador).
 * LOCAL: se calculan con Game.calculateFinalScores().
 */
function showGameOverModal(results = null) {
  const gs = Game.gameState;
  const isOnline = gs.isOnline;

  if (isOnline) {
    // ── ONLINE: usar directamente los resultados del servidor ──
    // Forma del servidor: { index, name, isBot, score, isWinner, cards: [card|null,...] }
    const res = (results && results.length) ? results : [];
    const titleEl = el('game-over-title');
    const subEl   = el('game-over-subtitle');
    const resEl   = el('game-over-results');

    const winners = res.filter(r => r.isWinner);
    if (winners.length === 1) {
      titleEl.textContent = `🏆 ¡${winners[0].name} GANA!`;
    } else if (winners.length > 1) {
      titleEl.textContent = `🏆 ¡EMPATE!`;
    } else {
      titleEl.textContent = '🏆 Partida Terminada';
    }

    const doshName = gs.doshAnnouncedBy !== null && gs.players[gs.doshAnnouncedBy]
      ? gs.players[gs.doshAnnouncedBy].name : null;
    subEl.textContent = doshName
      ? `${doshName} cantó ¡DOSH! Puntuación final (menor = mejor). Jokers = 15 pts, K negra = 13, K roja = 0.`
      : 'Puntuación final (menor = mejor). Jokers = 15 pts, K negra = 13, K roja = 0, As = 1...';

    resEl.innerHTML = '';
    res.forEach((r, idx) => {
      const row = document.createElement('div');
      row.className = `player-score-row${r.isWinner ? ' winner' : ''}`;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'player-score-name';
      nameSpan.innerHTML = `${r.isWinner ? '👑 ' : ''}<strong>${idx + 1}.</strong> ${r.name}`;

      const cardsDiv = document.createElement('span');
      cardsDiv.className = 'player-score-cards';
      (r.cards || []).forEach(card => {
        if (card) {
          const sym  = SUIT_SYMBOLS[card.suit];
          const mini = document.createElement('span');
          mini.className = `card face-up ${card.color}`;
          mini.style.cssText = 'width:36px;height:52px;font-size:0.7rem;display:inline-flex;align-items:center;justify-content:center;';
          mini.textContent = `${card.rank}${sym}`;
          cardsDiv.appendChild(mini);
        }
      });

      const ptsSpan = document.createElement('span');
      ptsSpan.className = 'player-score-pts';
      ptsSpan.textContent = `${r.score} pts`;

      row.appendChild(nameSpan);
      row.appendChild(cardsDiv);
      row.appendChild(ptsSpan);
      resEl.appendChild(row);
    });

    show('modal-game-over');

    // Botón "Volver al lobby" para todos (el servidor avisa a los demás vía BACK_TO_LOBBY)
    const btnRestart = el('btn-modal-restart');
    if (btnRestart) {
      btnRestart.onclick = () => {
        if (Network.isHost()) {
          Network.send({ type: 'BACK_TO_LOBBY' });
        }
        hide('modal-game-over');
      };
    }
    return;
  }

  // ── MODO LOCAL (bots en un solo dispositivo) ──
  results = Game.calculateFinalScores();

  // Título y subtítulo
  const titleEl = el('game-over-title');
  const subEl   = el('game-over-subtitle');
  const resEl   = el('game-over-results');

  // ¿Hay un ganador inmediato (0 cartas)?
  const immediateWinner = gs.players.find(p => p.hand.length === 0);
  if (immediateWinner) {
    titleEl.textContent = `🏆 ¡${immediateWinner.name} GANA!`;
    subEl.textContent   = `Se quedó con 0 cartas. ¡Victoria inmediata!`;
  } else if (gs.doshAnnouncedBy !== null) {
    const doshPlayer = gs.players[gs.doshAnnouncedBy];
    const winners = results.filter(r => r.isWinner);
    if (winners.length === 1) {
      titleEl.textContent = `🏆 ¡${winners[0].player.name} GANA!`;
    } else {
      titleEl.textContent = `🏆 ¡EMPATE!`;
    }
    subEl.textContent = `${doshPlayer.name} cantó ¡DOSH! Los turnos se cerraron. Puntuación final (menor = mejor). Jokers = 15 pts, K negra = 13, K roja = 0.`;
  } else {
    const winners = results.filter(r => r.isWinner);
    if (winners.length === 1) {
      titleEl.textContent = `🏆 ¡${winners[0].player.name} GANA!`;
    } else {
      titleEl.textContent = `🏆 ¡EMPATE!`;
    }
    subEl.textContent = 'Puntuación final (menor = mejor). Jokers = 15 pts, K negra = 13, K roja = 0, As = 1...';
  }

  // Resultados
  resEl.innerHTML = '';
  results.forEach((r, idx) => {
    const row = document.createElement('div');
    row.className = `player-score-row${r.isWinner ? ' winner' : ''}`;

    // Nombre con posición
    const nameSpan = document.createElement('span');
    nameSpan.className = 'player-score-name';
    nameSpan.innerHTML = `${r.isWinner ? '👑 ' : ''}<strong>${idx + 1}.</strong> ${r.player.name}`;

    // Mini cartas reveladas
    const cardsDiv = document.createElement('span');
    cardsDiv.className = 'player-score-cards';
    r.player.hand.forEach(slot => {
      if (slot && slot.card) {
        const sym  = SUIT_SYMBOLS[slot.card.suit];
        const mini = document.createElement('span');
        mini.className = `card face-up ${slot.card.color}`;
        mini.style.cssText = 'width:36px;height:52px;font-size:0.7rem;display:inline-flex;align-items:center;justify-content:center;';
        mini.textContent = `${slot.card.rank}${sym}`;
        cardsDiv.appendChild(mini);
      }
    });

    // Puntuación
    const ptsSpan = document.createElement('span');
    ptsSpan.className = 'player-score-pts';
    ptsSpan.textContent = `${r.score} pts`;

    row.appendChild(nameSpan);
    row.appendChild(cardsDiv);
    row.appendChild(ptsSpan);
    resEl.appendChild(row);
  });

  show('modal-game-over');

  // Botón restart del modal
  const btnRestart = el('btn-modal-restart');
  if (btnRestart) {
    btnRestart.onclick = () => {
      hide('modal-game-over');
      renderSetup();
    };
  }
}

// ─── Utilidades DOM ───────────────────────────────────────────────────────────

function el(id)   { return document.getElementById(id); }
function show(id) { const e = el(id); if (e) e.classList.remove('hidden'); }
function hide(id) { const e = el(id); if (e) e.classList.add('hidden'); }

// ─── Exportar ─────────────────────────────────────────────────────────────────

const UI = {
  renderModeSelect,
  renderOnlineScreen,
  renderSetup,
  updatePlayerNameInputs,
  getSetupValues,
  showSetupError,
  clearSetupError,
  renderPeekScreen,
  startPeekTimer,
  endPeekTurn,
  renderGameTable,
  updateTurnUI,
  renderPlayers,
  renderDeck,
  renderTableCard,
  setGameStatus,
  setGameMessage,
  showGameOverModal,
  startSequentialRevealPhase,
  startTurnTimer,
  stopTurnTimer,
  startOnlineGame,
  startOnlinePeekTimer,
  endOnlinePeekTurn,
  applyServerState,
  applyPeekReveal,
};
