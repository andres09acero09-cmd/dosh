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
};

// ─── Navegación ───────────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
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

/** El jugador toca una carta boca abajo para verla.  */
function _onPeekCardClick(slotIndex) {
  if (!uiState.peekActive) return;

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

  // Si cambió de jugador en su turno, reiniciar el temporizador de 30 segundos
  if (uiState.lastPlayerIndex !== gs.currentPlayerIndex && (gs.gameStatus === 'playing' || gs.gameStatus === 'dosh')) {
    uiState.lastPlayerIndex = gs.currentPlayerIndex;
    startTurnTimer();
  }

  renderPlayers();
  renderDeck();
  renderTableCard();
  _updateActionArea();
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

    const nameDiv = document.createElement('div');
    nameDiv.className   = 'player-name';
    nameDiv.textContent = player.name;

    const cardsDiv = document.createElement('div');
    cardsDiv.className = 'player-cards';

    player.hand.forEach((slot, sIndex) => {
      let isTarget = false;
      let targetClick = null;
      let extraClass = '';

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

  // Permitir voltear carta haciendo clic en el mazo SOLO si no hay ya una carta volteada pendiente y en modo idle
  if ((gs.gameStatus === 'playing' || gs.gameStatus === 'dosh') && uiState.turnMode === 'idle' && !gs.drawnCard && gs.deck.length > 0) {
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
  // Excluimos la carta superior actual para no duplicarla
  const previousCards = (gs.tableHistory || []).filter(c => c !== topCard);

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

  // ── Modos especiales de selección de cartas ──
  if (uiState.turnMode === 'q_peek') {
    setGameMessage('👁 PODER DE LA Q: Toca una de TUS cartas para verla.', 'warning');
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-secondary';
    btnCancel.textContent = 'OMITIR (NO VER CARTA)';
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

  if (uiState.turnMode === 'joker_red_select') {
    setGameMessage('🔥 PODER DEL JOKER ROJO: Toca la carta de TU baraja que deseas botar a la mesa (quedará encima del Joker Rojo).', 'warning');
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-secondary';
    btnCancel.textContent = 'CANCELAR';
    btnCancel.onclick = _onCancelAction;
    actContainer.appendChild(btnCancel);
    return;
  }

  if (uiState.turnMode === 'joker_black_select_player') {
    setGameMessage('⚡ PODER DEL JOKER NEGRO: Elige a qué rival castigar con 2 cartas del mazo (pasará a su turno y no podrá coger el Joker):', 'warning');
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
    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn-secondary';
    btnCancel.textContent = 'CANCELAR';
    btnCancel.onclick = _onCancelAction;
    actContainer.appendChild(btnCancel);
    return;
  }

  // ── Función helper para añadir botones de poderes (Q, J, Jokers) ──
  function _appendPowerButtons() {
    // Poder de la Q: disponible si la Q está en cadena o si la carta volteada es una Q
    const qAvailable = gs.qChainActive || (gs.drawnCard && gs.drawnCard.rank === 'Q');
    if (qAvailable) {
      const btnQ = document.createElement('button');
      btnQ.className = 'btn-secondary btn-power-q';
      btnQ.textContent = '👁 VER CARTA (Q)';
      btnQ.onclick = () => { uiState.turnMode = 'q_peek'; updateTurnUI(); };
      actContainer.appendChild(btnQ);
    }

    // Poder de la J: solo si jPowerUsable (volteada del mazo o copia de J)
    if (gs.jPowerUsable) {
      const btnJ = document.createElement('button');
      btnJ.className = 'btn-secondary btn-power-j';
      btnJ.textContent = '🔄 INTERCAMBIAR (J)';
      btnJ.onclick = () => { uiState.turnMode = 'j_select_my'; updateTurnUI(); };
      actContainer.appendChild(btnJ);
    }

    // Poder del Joker Rojo: al voltear Joker Rojo
    if (gs.drawnCard && gs.drawnCard.rank === 'JOKER' && gs.drawnCard.color === 'red') {
      const btnJokerRed = document.createElement('button');
      btnJokerRed.className = 'btn-primary';
      btnJokerRed.style.background = 'linear-gradient(135deg, #e03131, #c92a2a)';
      btnJokerRed.textContent = '🔥 PODER JOKER ROJO: BOTAR CARTA';
      btnJokerRed.onclick = () => { uiState.turnMode = 'joker_red_select'; updateTurnUI(); };
      actContainer.appendChild(btnJokerRed);
    }

    // Poder del Joker Negro: al voltear Joker Negro
    if (gs.drawnCard && gs.drawnCard.rank === 'JOKER' && gs.drawnCard.color === 'black') {
      const btnJokerBlack = document.createElement('button');
      btnJokerBlack.className = 'btn-primary';
      btnJokerBlack.style.background = 'linear-gradient(135deg, #343a40, #212529)';
      btnJokerBlack.textContent = '⚡ PODER JOKER NEGRO: CASTIGAR (+2)';
      btnJokerBlack.onclick = () => { uiState.turnMode = 'joker_black_select_player'; updateTurnUI(); };
      actContainer.appendChild(btnJokerBlack);
    }
  }

  // ── Botón DOSH: ÚNICAMENTE visible antes de comenzar a jugar su turno ──
  function _appendDoshButton() {
    if (gs.doshAnnouncedBy === null && !gs.drawnCard && uiState.turnMode === 'idle' && !gs.tableCardMatchedThisTurn) {
      const btnDosh = document.createElement('button');
      btnDosh.className = 'btn-primary btn-dosh';
      btnDosh.textContent = '¡DOSH!';
      btnDosh.onclick = _onDoshClick;
      actContainer.appendChild(btnDosh);
    }
  }

  // CASO 1: No hay carta en juego todavía (ni volteada del mazo en este turno)
  if (!gs.drawnCard) {
    if (gs.activeTableCard) {
      const tableLabel = Deck.getCardLabel(gs.activeTableCard);
      const isBlockedBlackJoker = gs.jokerBlackBlocked && gs.activeTableCard.rank === 'JOKER' && gs.activeTableCard.color === 'black';

      // SUB-CASO: Ya hizo copia con la de la mesa en este turno -> solo puede voltear del mazo
      if (gs.tableCardMatchedThisTurn) {
        setGameMessage(`¡Copia exitosa! Continúa tu turno: debes voltear una carta del mazo (no puedes cambiar la carta que acabas de emparejar):`, 'info');
        const btnDraw = document.createElement('button');
        btnDraw.className = 'btn-primary';
        btnDraw.textContent = 'VOLTEAR DEL MAZO';
        btnDraw.onclick = _onDrawCardClick;
        actContainer.appendChild(btnDraw);

        _appendPowerButtons();
        return;
      }

      if (uiState.turnMode === 'idle') {
        if (isBlockedBlackJoker) {
          setGameMessage(`En la mesa está ${tableLabel}, ¡pero fuiste castigado y NO puedes coger el Joker Negro! Debes voltear del mazo:`, 'warning');
        } else {
          setGameMessage(`En la mesa está ${tableLabel} (dejada anteriormente). Puedes usarla, o voltear una nueva del mazo si no te sirve:`, 'info');
        }

        // Botón: Voltear del mazo
        const btnDraw = document.createElement('button');
        btnDraw.className = 'btn-primary';
        btnDraw.textContent = 'VOLTEAR DEL MAZO';
        btnDraw.onclick = _onDrawCardClick;
        actContainer.appendChild(btnDraw);

        // Botón: Cambiarla (solo si no está bloqueado coger el Joker Negro)
        if (!isBlockedBlackJoker) {
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

        _appendPowerButtons();
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

      _appendPowerButtons();
      _appendDoshButton();
    }

  } else {
    // CASO 2: El jugador acaba de voltear una carta del mazo en este turno
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

  uiState.turnMode = 'idle';
  updateTurnUI();
}

function _onStartReplaceTableClick() {
  const result = Game.useTableCardForCurrentPlayer();
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }
  uiState.turnMode = 'replace';
  updateTurnUI();
}

function _onStartMatchTableClick() {
  const result = Game.useTableCardForCurrentPlayer();
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }
  uiState.turnMode = 'match';
  updateTurnUI();
}

function _onPassTurnClick() {
  const currentName = Game.getCurrentPlayer().name;
  Game.nextTurn();
  uiState.turnMode = 'idle';
  setGameMessage(`${currentName} decidió dejar la carta en la mesa. Le toca al siguiente jugador.`, 'info');
  updateTurnUI();
}

async function _onDiscardClick() {
  const currentName = Game.getCurrentPlayer().name;
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
  // Si habíamos cargado la carta de la mesa en drawnCard, la regresamos a idle
  if (Game.gameState.activeTableCard === Game.gameState.drawnCard) {
    Game.gameState.drawnCard = null;
  }
  uiState.turnMode = 'idle';
  updateTurnUI();
}

async function _onSlotReplaceClick(slotIndex) {
  const currentName = Game.getCurrentPlayer().name;
  const playerIndex = Game.gameState.currentPlayerIndex;

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

  uiState.turnMode = 'idle';
  setGameMessage(`${currentName} cambió una carta. El ${Deck.getCardLabel(result.oldCard)} quedó en la mesa.`, 'success');
  Anim.toast('♻ Cambio realizado', 'success', 1200);
  updateTurnUI();
}

async function _onSlotMatchClick(slotIndex) {
  const current     = Game.getCurrentPlayer();
  const playerIndex = Game.gameState.currentPlayerIndex;

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

  if ((slot.faceUp || (slot.card && slot.card.faceUp)) && slot.card) {
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
    if (selectable && Game.gameState.peekPhase.cardsLeftToReveal > 0
        && !Game.gameState.peekPhase.revealedThisPeek.includes(slotIndex)) {
      div.classList.add('selectable');
      div.addEventListener('click', () => _onPeekCardClick(slotIndex));
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

function _onTurnTimeout() {
  const gs = Game.gameState;
  const currentName = Game.getCurrentPlayer().name;

  // Si hay una carta volteada pendiente, la dejamos en la mesa
  if (gs.drawnCard) {
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
  const current = Game.getCurrentPlayer();
  const currentName = current.name;
  const slot = current.hand[slotIndex];
  if (!slot || !slot.card) return;

  uiState.turnMode = 'idle';
  stopTurnTimer();

  // 1. Voltear físicamente la carta boca arriba en la mano del jugador
  slot.faceUp = true;
  slot.known = true;
  if (slot.card) slot.card.faceUp = true;
  renderPlayers();

  const cardLabel = Deck.getCardLabel(slot.card);

  // 2. Dejar ver durante 5 segundos con cuenta atrás visible
  for (let s = 5; s >= 1; s--) {
    setGameMessage(`👁 Viendo tu carta (${cardLabel}): ${s} segundo${s !== 1 ? 's' : ''}...`, 'info');
    await _sleep(1000);
  }

  // 3. Voltear la carta nuevamente boca abajo
  slot.faceUp = false;
  if (slot.card) slot.card.faceUp = false;
  renderPlayers();

  // 4. Aplicar el efecto de la Q en la lógica del juego (avanza turno)
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
  const mySlot = uiState.jSelectedMySlot;
  if (mySlot === null) return;

  const currentPlayer = Game.getCurrentPlayer();
  const targetPlayer  = Game.gameState.players[targetPlayerIndex];
  const currentName   = currentPlayer.name;
  const targetName    = targetPlayer.name;

  const playerAreaA = el(`player-${Game.gameState.currentPlayerIndex}`);
  const playerAreaB = el(`player-${targetPlayerIndex}`);
  const cardElsA    = playerAreaA ? playerAreaA.querySelectorAll('.card') : [];
  const cardElsB    = playerAreaB ? playerAreaB.querySelectorAll('.card') : [];
  const slotElA     = cardElsA[mySlot] || null;
  const slotElB     = cardElsB[targetSlotIndex] || null;

  // Realizar animación de intercambio físico entre las dos cartas BOCA ABAJO (sin revelar qué cartas son)
  if (slotElA && slotElB) {
    await Anim.swapCardsBetweenSlots(slotElA, slotElB, null, null);
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
  const currentName = Game.getCurrentPlayer().name;
  const playerIndex = Game.gameState.currentPlayerIndex;

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
  const currentName  = Game.getCurrentPlayer().name;
  const targetPlayer = Game.gameState.players[targetPlayerIndex];

  const result = Game.useJokerBlackPower(targetPlayerIndex);
  if (!result.success) {
    setGameMessage(result.error, 'error');
    return;
  }

  uiState.turnMode = 'idle';
  await Anim.toast(`⚡ ¡${currentName} castigó a ${targetPlayer.name} (+2 cartas)! Turno de ${targetPlayer.name}`, 'warning', 2600);

  const targetArea = el(`player-${targetPlayerIndex}`);
  if (targetArea) {
    await Anim.penaltyFly(targetArea);
  }

  updateTurnUI();
}

// ─── Handler de DOSH ──────────────────────────────────────────────────────────

async function _onDoshClick() {
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

  // Iniciar timer regresivo de 5 segundos
  uiState.revealTimer = setInterval(() => {
    uiState.revealSecondsLeft--;
    if (uiState.revealSecondsLeft > 0) {
      btnReveal.textContent = `👁 REVELAR CARTAS (${uiState.revealSecondsLeft}s)`;
    } else {
      executeReveal();
    }
  }, 1000);
}

// ─── Modal de Fin de Partida ──────────────────────────────────────────────────

function showGameOverModal() {
  const results = Game.calculateFinalScores();
  const gs = Game.gameState;

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
};
