/**
 * game.js
 * Estado central y lógica de partida del juego DOS.
 *
 * Responsabilidades:
 *  - Mantener el gameState (estado único y central)
 *  - Configurar la partida (jugadores, cartas por jugador)
 *  - Repartir cartas
 *  - Gestionar la fase inicial de memoria (mirar la mitad)
 *  - Gestionar turnos (se ampliará en Fase 2)
 *
 * Depende de: deck.js, player.js
 * NO contiene lógica de interfaz.
 */

// ─── Estado central ───────────────────────────────────────────────────────────

/**
 * gameState es el único objeto de verdad del juego.
 * Toda la lógica lee y escribe aquí.
 *
 * Diseño preparado para multijugador:
 * En la versión online este objeto vivirá en el servidor.
 * Los clientes recibirán solo la "vista pública" de cada jugador.
 */
const gameState = {
  // Configuración de la partida
  playerCount:    0,       // Número de jugadores
  cardsPerPlayer: 0,       // Cartas repartidas a cada uno (siempre par)

  // Participantes
  players: [],             // Array de objetos Player

  // Baraja y mesa
  deck:            [],     // Mazo principal
  discardPile:     [],     // Historial interno
  tableHistory:    [],     // Historial de cartas dejadas en la mesa (para ver las cartas de abajo asomadas)
  activeTableCard: null,   // Carta visible en la mesa (la de arriba del todo)

  // Turno
  currentPlayerIndex: 0,   // Índice del jugador activo
  drawnCard:          null, // Carta recién volteada del mazo o tomada de la mesa
  drawnFromTable:     false, // true = la carta activa vino de la carta de mesa; false = del mazo

  // Fase "DOSH"
  doshAnnouncedBy: null,   // Índice del jugador que anunció DOSH
  lastRoundTurnsLeft: 0,   // Turnos restantes en la última ronda antes de cerrar y contar puntos

  // Poderes especiales: Q (mirar carta en cadena) y J (intercambiar)
  qChainActive: false,      // true si hay una Q activa que permite ver carta en cadena
  qOriginPlayerIndex: null, // Índice del jugador que lanzó/copió la última Q
  jPowerUsable: false,      // true si la J activa proviene del mazo o de copia (no de cambio previo)

  // Estado general
  gameStatus: "idle",      // "idle" | "dealing" | "peeking" | "playing" | "dosh" | "ended"

  // Fase de memoria inicial
  peekPhase: {
    active:           false, // ¿Estamos en la fase de mirar?
    currentPeekerIndex: 0,   // Qué jugador está mirando ahora
    cardsLeftToReveal:  0,   // Cuántas cartas le quedan por mirar al jugador actual
    revealedThisPeek:   [],  // Índices de slots ya revelados en esta sesión
  },
};

// ─── Configuración y validación ───────────────────────────────────────────────

/**
 * Valida que el número de cartas sea par.
 *
 * @param {number} count - Número de cartas a repartir
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateCardsPerPlayer(count, players = 2) {
  if (typeof Rules !== "undefined" && Rules.validateCardsPerPlayer) {
    return Rules.validateCardsPerPlayer(count, players);
  }
  if (!Number.isInteger(count) || count < 2) {
    return { valid: false, error: "El número de cartas debe ser un entero mayor o igual a 2." };
  }
  if (count % 2 !== 0) {
    return { valid: false, error: "El número de cartas debe ser par (2, 4, 6, 8…)." };
  }
  return { valid: true, error: null };
}

/**
 * Valida el número de jugadores.
 *
 * @param {number} count - Número de jugadores
 * @returns {{ valid: boolean, error: string|null }}
 */
function validatePlayerCount(count) {
  if (typeof Rules !== "undefined" && Rules.validatePlayerCount) {
    return Rules.validatePlayerCount(count);
  }
  if (!Number.isInteger(count) || count < 2) {
    return { valid: false, error: "Debe haber al menos 2 jugadores." };
  }
  if (count > 8) {
    return { valid: false, error: "El máximo de jugadores es 8." };
  }
  return { valid: true, error: null };
}

// ─── Inicializar partida ──────────────────────────────────────────────────────

/**
 * Inicializa una partida nueva.
 * Crea los jugadores, baraja el mazo y reparte las cartas.
 *
 * @param {string[]} playerNames   - Array con los nombres de los jugadores
 * @param {number}   cardsPerPlayer - Cartas a repartir (debe ser par)
 * @returns {{ success: boolean, error: string|null }}
 */
function initGame(playerNames, cardsPerPlayer) {
  // Validaciones
  const playerValidation = validatePlayerCount(playerNames.length);
  if (!playerValidation.valid) return { success: false, error: playerValidation.error };

  const cardsValidation = validateCardsPerPlayer(cardsPerPlayer, playerNames.length);
  if (!cardsValidation.valid) return { success: false, error: cardsValidation.error };

  // Verificar que haya cartas suficientes
  const totalCardsNeeded = playerNames.length * cardsPerPlayer;
  if (totalCardsNeeded > 54) {
    return {
      success: false,
      error: `No hay cartas suficientes. Se necesitan ${totalCardsNeeded} pero la baraja tiene 54.`,
    };
  }

  // Resetear estado
  gameState.playerCount    = playerNames.length;
  gameState.cardsPerPlayer = cardsPerPlayer;
  gameState.players        = [];
  gameState.discardPile    = [];
  gameState.tableHistory   = [];
  gameState.activeTableCard = null;
  gameState.drawnCard      = null;
  gameState.drawnFromTable = false;
  gameState.doshAnnouncedBy = null;
  gameState.lastRoundTurnsLeft = 0;
  gameState.qChainActive   = false;
  gameState.qOriginPlayerIndex = null;
  gameState.jPowerUsable   = false;
  gameState.currentPlayerIndex = 0;
  gameState.gameStatus     = "dealing";

  // Crear jugadores
  for (let i = 0; i < playerNames.length; i++) {
    gameState.players.push(Player.createPlayer(i, playerNames[i]));
  }

  // Crear y barajar mazo
  gameState.deck = Deck.shuffleDeck(Deck.createDeck());

  // Repartir cartas
  dealCards();

  // Iniciar fase de memoria
  startPeekPhase();

  return { success: true, error: null };
}

// ─── Reparto ──────────────────────────────────────────────────────────────────

/**
 * Reparte las cartas a todos los jugadores.
 * Todas llegan boca abajo y desconocidas.
 * Se reparte de una en una en ronda (como en una partida real).
 */
function dealCards() {
  const { players, cardsPerPlayer } = gameState;

  for (let round = 0; round < cardsPerPlayer; round++) {
    for (const player of players) {
      const card = Deck.drawCard(gameState.deck);
      if (card) {
        Player.addCardToHand(player, card, false, false);
      }
    }
  }
}

// ─── Fase de memoria (mirar la mitad) ────────────────────────────────────────

/**
 * Inicia la fase donde cada jugador mira la mitad de sus cartas.
 * Se recorre jugador por jugador de forma secuencial.
 */
function startPeekPhase() {
  gameState.gameStatus = "peeking";
  gameState.peekPhase = {
    active:             true,
    currentPeekerIndex: 0,
    cardsLeftToReveal:  gameState.cardsPerPlayer / 2,
    revealedThisPeek:   [],
  };
}

/**
 * Devuelve el jugador que está mirando sus cartas ahora mismo.
 *
 * @returns {Object} El jugador activo en la fase de memoria
 */
function getCurrentPeeker() {
  return gameState.players[gameState.peekPhase.currentPeekerIndex];
}

/**
 * El jugador actual selecciona una carta para mirarla.
 * Solo puede mirar cartas que todavía no ha revelado en esta fase.
 *
 * @param {number} slotIndex - Posición en la mano del jugador
 * @returns {{ success: boolean, error: string|null }}
 */
function peekCard(slotIndex) {
  const peek   = gameState.peekPhase;
  const player = getCurrentPeeker();

  if (!peek.active) return { success: false, error: "No estamos en la fase de memoria." };
  if (peek.cardsLeftToReveal <= 0) return { success: false, error: "Ya miraste todas las cartas que puedes." };
  if (peek.revealedThisPeek.includes(slotIndex)) return { success: false, error: "Ya miraste esa carta." };
  if (!player.hand[slotIndex]) return { success: false, error: "Posición inválida." };

  // Revelar la carta
  Player.revealCard(player, slotIndex);
  peek.revealedThisPeek.push(slotIndex);
  peek.cardsLeftToReveal--;

  return { success: true, error: null };
}

/**
 * El jugador actual termina de mirar (o se acabaron sus cartas permitidas).
 * Oculta todas sus cartas y pasa al siguiente jugador.
 * Si ya pasaron todos, termina la fase y comienza el juego.
 *
 * @returns {{ peekPhaseEnded: boolean }} Si la fase de memoria terminó para todos
 */
function finishPeeking() {
  const peek   = gameState.peekPhase;
  const player = getCurrentPeeker();

  // Ocultar todas las cartas del jugador actual
  Player.hideAllCards(player);

  // Pasar al siguiente jugador
  peek.currentPeekerIndex++;
  peek.revealedThisPeek  = [];
  peek.cardsLeftToReveal = gameState.cardsPerPlayer / 2;

  // ¿Terminaron todos?
  if (peek.currentPeekerIndex >= gameState.players.length) {
    peek.active      = false;
    gameState.gameStatus = "playing";
    return { peekPhaseEnded: true };
  }

  return { peekPhaseEnded: false };
}

// ─── Consultas de estado ──────────────────────────────────────────────────────

/**
 * Devuelve el jugador cuyo turno es ahora (durante la fase de juego).
 *
 * @returns {Object} El jugador activo
 */
function getCurrentPlayer() {
  return gameState.players[gameState.currentPlayerIndex];
}

/**
 * Devuelve cuántas cartas le quedan al jugador actual por mirar en la fase inicial.
 *
 * @returns {number}
 */
function getCardsLeftToPeek() {
  return gameState.peekPhase.cardsLeftToReveal;
}

// ─── Lógica del turno normal ──────────────────────────────────────────────────

/**
 * El jugador decide usar la carta que ya está descubierta en la mesa (dejada por el jugador anterior).
 *
 * @returns {{ success: boolean, card: Object|null, error: string|null }}
 */
function useTableCardForCurrentPlayer() {
  if (gameState.gameStatus !== "playing" && gameState.gameStatus !== "dos") {
    return { success: false, card: null, error: "La partida no está en curso." };
  }
  if (!gameState.activeTableCard) {
    return { success: false, card: null, error: "No hay ninguna carta en la mesa para tomar." };
  }
  if (gameState.drawnCard !== null) {
    return { success: false, card: null, error: "Ya tienes una carta en juego." };
  }

  // La carta de la mesa pasa a ser la carta activa con la que el jugador interactuará
  gameState.drawnCard      = gameState.activeTableCard;
  gameState.drawnFromTable = true;
  return { success: true, card: gameState.drawnCard, error: null };
}

/**
 * El jugador voltea una nueva carta del mazo (ya sea porque la mesa está vacía o porque la que dejó el anterior no le sirve).
 *
 * @returns {{ success: boolean, card: Object|null, error: string|null }}
 */
function drawCardForCurrentPlayer() {
  if (gameState.gameStatus !== "playing" && gameState.gameStatus !== "dos") {
    return { success: false, card: null, error: "La partida no está en curso." };
  }
  if (gameState.drawnCard !== null) {
    return { success: false, card: null, error: "Ya tienes una carta en juego. Debes decidir qué hacer con ella." };
  }
  if (gameState.deck.length === 0) {
    return { success: false, card: null, error: "No quedan cartas en el mazo principal." };
  }

  const card = Deck.drawCard(gameState.deck);
  gameState.drawnCard      = card;
  gameState.drawnFromTable = false;

  // Si roba del mazo y no es una Q, se rompe la cadena de ver carta de la Q
  if (card.rank !== "Q") {
    gameState.qChainActive = false;
    gameState.qOriginPlayerIndex = null;
  }

  // La J volteada del mazo sí permite usar su poder
  gameState.jPowerUsable = (card.rank === "J");

  return { success: true, card: card, error: null };
}

/**
 * Acción: Dejarla.
 * La carta actual queda visible en la mesa para el siguiente jugador y termina el turno.
 *
 * @returns {{ success: boolean, discarded: Object|null, error: string|null }}
 */
function discardDrawnCard() {
  if (!gameState.drawnCard) {
    return { success: false, discarded: null, error: "No hay carta activa para dejar." };
  }

  const leftCard = gameState.drawnCard;
  gameState.tableHistory.push(leftCard);
  gameState.activeTableCard = leftCard; // Queda en la mesa como la superior
  gameState.drawnCard = null;
  gameState.drawnFromTable = false;
  gameState.jPowerUsable = false;

  // Si no se usó el poder de la Q, se rompe la cadena
  if (gameState.qChainActive && gameState.currentPlayerIndex === gameState.qOriginPlayerIndex) {
    gameState.qChainActive = false;
    gameState.qOriginPlayerIndex = null;
  }

  nextTurn();

  return { success: true, discarded: leftCard, error: null };
}

/**
 * Acción: Cambiarla (Reemplazar una carta de la mano por la carta activa).
 * El jugador puede elegir cualquiera de sus cartas (las haya visto o no).
 * La carta que saca de su mano queda en la mesa para el siguiente usuario.
 *
 * @param {number} slotIndex - Posición de la carta en la mano del jugador
 * @returns {{ success: boolean, oldCard: Object|null, error: string|null }}
 */
function replaceCardWithDrawn(slotIndex) {
  if (!gameState.drawnCard) {
    return { success: false, oldCard: null, error: "No hay carta activa para cambiar." };
  }

  const player = getCurrentPlayer();
  const slot = player.hand[slotIndex];

  const takenCard = gameState.drawnCard;
  const oldCard = Player.replaceCardInHand(player, slotIndex, takenCard);

  // Si la carta activa se tomó de la mesa, se retira del historial de la mesa porque ahora está en la mano del jugador
  if (gameState.drawnFromTable) {
    const idx = gameState.tableHistory.lastIndexOf(takenCard);
    if (idx !== -1) {
      gameState.tableHistory.splice(idx, 1);
    }
  }

  // La carta que sacó de su baraja queda descubierta en la mesa como la superior
  gameState.tableHistory.push(oldCard);
  gameState.activeTableCard = oldCard;
  gameState.drawnCard = null;
  gameState.drawnFromTable = false;

  // Cambiar una carta rompe el poder de J y la cadena de Q
  gameState.jPowerUsable = false;
  gameState.qChainActive = false;
  gameState.qOriginPlayerIndex = null;

  nextTurn();

  return { success: true, oldCard: oldCard, error: null };
}

/**
 * Poder de la Q: Ver una carta propia.
 * El jugador puede ver la carta elegida de su baraja.
 * Se inicia o mantiene la cadena de la Q para los siguientes jugadores hasta que vuelva al originador.
 *
 * @param {number} slotIndex - Posición de la carta en la mano que desea ver
 * @returns {{ success: boolean, card: Object|null, slotIndex: number, error: string|null }}
 */
function useQPower(slotIndex) {
  const player = getCurrentPlayer();
  if (!player || !player.hand[slotIndex]) {
    return { success: false, card: null, slotIndex: -1, error: "Posición inválida en la mano." };
  }

  const slot = player.hand[slotIndex];
  slot.known = true; // El jugador ahora conoce su carta

  // Si había una carta activa (Q volteada), pasa a la mesa
  if (gameState.drawnCard) {
    if (!gameState.tableHistory.includes(gameState.drawnCard)) {
      gameState.tableHistory.push(gameState.drawnCard);
    }
    gameState.activeTableCard = gameState.drawnCard;
    gameState.drawnCard = null;
    gameState.drawnFromTable = false;
  }

  // Se activa o mantiene la cadena de la Q
  gameState.qChainActive = true;
  if (gameState.qOriginPlayerIndex === null) {
    gameState.qOriginPlayerIndex = gameState.currentPlayerIndex;
  }
  gameState.jPowerUsable = false;

  nextTurn();

  return { success: true, card: slot.card, slotIndex: slotIndex, error: null };
}

/**
 * Poder de la J: Intercambiar una carta propia por una de cualquier otro jugador.
 * Las cartas intercambiadas conservan exactamente los mismos slots de procedencia.
 *
 * @param {number} mySlotIndex - Índice de la carta propia
 * @param {number} targetPlayerIndex - Índice del jugador rival
 * @param {number} targetSlotIndex - Índice de la carta del jugador rival
 * @returns {{ success: boolean, myCard: Object|null, targetCard: Object|null, error: string|null }}
 */
function useJPower(mySlotIndex, targetPlayerIndex, targetSlotIndex) {
  if (!gameState.jPowerUsable) {
    return { success: false, myCard: null, targetCard: null, error: "El poder de la J no está disponible en este momento." };
  }

  const currentPlayer = getCurrentPlayer();
  const targetPlayer = gameState.players[targetPlayerIndex];

  if (!targetPlayer || targetPlayer.id === currentPlayer.id) {
    return { success: false, myCard: null, targetCard: null, error: "Debes seleccionar a otro jugador." };
  }

  const res = Player.swapCardsBetweenPlayers(currentPlayer, mySlotIndex, targetPlayer, targetSlotIndex);
  if (!res.success) {
    return { success: false, myCard: null, targetCard: null, error: res.error };
  }

  // Si había una J activa en mesa/volteada, pasa a la mesa
  if (gameState.drawnCard) {
    if (!gameState.tableHistory.includes(gameState.drawnCard)) {
      gameState.tableHistory.push(gameState.drawnCard);
    }
    gameState.activeTableCard = gameState.drawnCard;
    gameState.drawnCard = null;
    gameState.drawnFromTable = false;
  }

  gameState.jPowerUsable = false;
  gameState.qChainActive = false;
  gameState.qOriginPlayerIndex = null;

  nextTurn();

  return {
    success: true,
    myCard: res.cardA,
    targetCard: res.cardB,
    error: null,
  };
}

/**
 * Cantar ¡DOSH!
 * Activa la última ronda para el resto de los jugadores.
 *
 * @returns {{ success: boolean, player: Object|null, turnsLeft: number, error: string|null }}
 */
function announceDosh() {
  if (gameState.doshAnnouncedBy !== null) {
    return { success: false, player: null, turnsLeft: 0, error: "¡DOSH ya ha sido cantado!" };
  }

  const player = getCurrentPlayer();
  gameState.doshAnnouncedBy = gameState.currentPlayerIndex;
  // Cada uno de los demás jugadores tiene exactamente 1 turno restante
  gameState.lastRoundTurnsLeft = gameState.players.length - 1;
  gameState.gameStatus = "dosh";

  return {
    success: true,
    player: player,
    turnsLeft: gameState.lastRoundTurnsLeft,
    error: null,
  };
}

/**
 * Calcula las puntuaciones finales al terminar la partida.
 * Revela todas las cartas y calcula la suma de puntos (K roja = 0, As = 1... K negra = 13).
 *
 * @returns {Array<{ player: Object, score: number, cardCount: number, isWinner: boolean }>}
 */
function calculateFinalScores() {
  const results = gameState.players.map((p) => {
    let score = 0;
    p.hand.forEach((slot) => {
      if (slot && slot.card) {
        slot.card.faceUp = true;
        slot.known = true;
        score += (typeof Rules !== "undefined" && Rules.getCardValue)
          ? Rules.getCardValue(slot.card)
          : 0;
      }
    });
    return {
      player: p,
      score: score,
      cardCount: p.hand.length,
      isWinner: false,
    };
  });

  results.sort((a, b) => a.score - b.score);
  const minScore = results[0]?.score ?? 0;
  results.forEach((r) => {
    r.isWinner = (r.score === minScore);
  });

  return results;
}

/**
 * Acción: Hacer copia (Emparejar).
 * El jugador elige la carta de su baraja que cree que es igual a la carta de la mesa/volteada.
 * - Si coincide: se une a la mesa y se reduce una carta.
 * - Si NO coincide: conserva su carta en la mano y se come una carta del mazo sin verla (+1 carta).
 * En ambos casos, la carta queda en la mesa para el siguiente jugador.
 *
 * @param {number} slotIndex - Posición de la carta elegida en la mano
 * @returns {{ success: boolean, matched: boolean, removedCard: Object|null, revealedCard: Object|null, penaltyCard: Object|null, gameEnded: boolean, winner: Object|null, error: string|null }}
 */
function matchCardWithDrawn(slotIndex) {
  if (!gameState.drawnCard) {
    return { success: false, matched: false, removedCard: null, revealedCard: null, penaltyCard: null, gameEnded: false, winner: null, error: "No hay carta activa para hacer copia." };
  }

  const player = getCurrentPlayer();
  const slot = player.hand[slotIndex];

  if (!slot || !slot.card) {
    return { success: false, matched: false, removedCard: null, revealedCard: null, penaltyCard: null, gameEnded: false, winner: null, error: "Posición inválida en la mano." };
  }

  const isMatch = (typeof Rules !== "undefined" && Rules.areMatchingCards)
    ? Rules.areMatchingCards(gameState.drawnCard, slot.card)
    : (slot.card.rank === gameState.drawnCard.rank);

  if (isMatch) {
    // ── Coincidencia exitosa ──
    const removedCard = Player.removeCardFromHand(player, slotIndex);
    const matchedRank = removedCard.rank;

    // Ambas cartas se incorporan al historial de la mesa
    if (!gameState.tableHistory.includes(gameState.drawnCard)) {
      gameState.tableHistory.push(gameState.drawnCard);
    }
    gameState.tableHistory.push(removedCard);
    gameState.activeTableCard = removedCard;

    const wasFromTable = gameState.drawnFromTable;
    gameState.drawnCard      = null;
    gameState.drawnFromTable = false;

    // Si llega a 0 cartas, gana inmediatamente
    if (player.hand.length === 0) {
      gameState.gameStatus = "ended";
      return { success: true, matched: true, removedCard: removedCard, revealedCard: null, penaltyCard: null, gameEnded: true, winner: player, drawnFromTable: wasFromTable, matchedRank: matchedRank, error: null };
    }

    // Si emparejó una J, puede usar el poder de la J
    if (matchedRank === "J") {
      gameState.jPowerUsable = true;
    } else {
      gameState.jPowerUsable = false;
    }

    // Si emparejó una Q, inicia o reinicia la cadena de la Q con este jugador
    if (matchedRank === "Q") {
      gameState.qChainActive = true;
      gameState.qOriginPlayerIndex = gameState.currentPlayerIndex;
    }

    // Si la carta vino del mazo y no tiene poder de J para usar, avanza turno
    if (!wasFromTable && matchedRank !== "J") {
      nextTurn();
    }

    return {
      success: true,
      matched: true,
      removedCard: removedCard,
      revealedCard: null,
      penaltyCard: null,
      gameEnded: false,
      winner: null,
      drawnFromTable: wasFromTable,
      matchedRank: matchedRank,
      error: null,
    };
  } else {
    // ── No coincide (Fallo al hacer copia) ──
    const revealedCard = slot.card;
    slot.known = true; // El jugador ahora conoce la carta porque la reveló

    // Penalización: Se tiene que comer una carta del mazo sin verla (queda al inicio / izquierda)
    const penaltyCard = Deck.drawCard(gameState.deck);
    if (penaltyCard) {
      Player.addCardToHand(player, penaltyCard, false, false, true);
      player.penaltyCount = (player.penaltyCount || 0) + 1;
    }

    // La carta activa queda en la mesa para el siguiente jugador
    if (!gameState.tableHistory.includes(gameState.drawnCard)) {
      gameState.tableHistory.push(gameState.drawnCard);
    }
    gameState.activeTableCard = gameState.drawnCard;

    const wasFromTable = gameState.drawnFromTable;
    gameState.drawnCard      = null;
    gameState.drawnFromTable = false;
    gameState.jPowerUsable   = false;
    gameState.qChainActive   = false;
    gameState.qOriginPlayerIndex = null;

    // El turno sólo avanza si la carta vino del mazo
    if (!wasFromTable) nextTurn();

    return {
      success: true,
      matched: false,
      removedCard: null,
      revealedCard: revealedCard,
      penaltyCard: penaltyCard,
      gameEnded: false,
      winner: null,
      drawnFromTable: wasFromTable,
      error: null,
    };
  }
}

/**
 * Avanza el turno al siguiente jugador disponible.
 * Si DOSH ha sido cantado, se descuenta un turno de la ronda final.
 *
 * @returns {Object} El nuevo jugador activo
 */
function nextTurn() {
  if (gameState.doshAnnouncedBy !== null && gameState.gameStatus !== "ended") {
    gameState.lastRoundTurnsLeft--;
    if (gameState.lastRoundTurnsLeft <= 0) {
      gameState.gameStatus = "ended";
      return getCurrentPlayer();
    }
  }

  gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
  gameState.jPowerUsable = false;

  // Si la cadena de Q estaba activa y volvió al originador, se termina la cadena
  if (gameState.qChainActive && gameState.currentPlayerIndex === gameState.qOriginPlayerIndex) {
    gameState.qChainActive = false;
    gameState.qOriginPlayerIndex = null;
  }

  return getCurrentPlayer();
}

// ─── Exportar ─────────────────────────────────────────────────────────────────

const Game = {
  gameState,
  initGame,
  validateCardsPerPlayer,
  validatePlayerCount,
  getCurrentPeeker,
  peekCard,
  finishPeeking,
  getCurrentPlayer,
  getCardsLeftToPeek,
  useTableCardForCurrentPlayer,
  drawCardForCurrentPlayer,
  discardDrawnCard,
  replaceCardWithDrawn,
  useQPower,
  useJPower,
  announceDosh,
  calculateFinalScores,
  matchCardWithDrawn,
  nextTurn,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Game;
}