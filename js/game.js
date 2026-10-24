/**
 * game.js
 * Estado central y lógica de partida del juego DOSH.
 *
 * Responsabilidades:
 *  - Definir el estado de una partida (único y central)
 *  - Configurar la partida (jugadores, cartas por jugador)
 *  - Repartir cartas
 *  - Gestionar la fase inicial de memoria (mirar la mitad)
 *  - Gestionar turnos y acciones (robar, cambiar, copia, poderes, DOSH)
 *
 * Diseño multijugador:
 *  - createGame() crea una PARTIDA INDEPENDIENTE con su propio estado.
 *    El servidor multijugador crea una instancia por sala (servidor autoritativo).
 *  - En el navegador se mantiene una instancia por defecto (Game.gameState)
 *    para el modo local.
 *
 * Depende de: deck.js, player.js, rules.js
 * NO contiene lógica de interfaz.
 */

// ─── Validaciones (independientes del estado) ─────────────────────────────────

/**
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

// ─── Fábrica de partida ──────────────────────────────────────────────────────

function createGame() {
  const state = {
    // Configuración de la partida
    playerCount:    0,       // Número de jugadores
    cardsPerPlayer: 0,       // Cartas repartidas a cada uno (siempre par)

    // Participantes
    players: [],             // Array de objetos Player

    // Baraja y mesa
    deck:            [],     // Mazo principal
    discardPile:     [],     // Historial interno
    tableHistory:    [],     // Historial de cartas dejadas en la mesa
    activeTableCard: null,   // Carta visible en la mesa (la de arriba del todo)

    // Turno
    currentPlayerIndex: 0,   // Índice del jugador activo
    drawnCard:          null, // Carta recién volteada del mazo o tomada de la mesa
    drawnFromTable:     false, // true = la carta activa vino de la carta de mesa

    // Identificador de turno (protege contra acciones atrasadas/duplicadas)
    turnId: 0,

    // Fase "DOSH"
    doshAnnouncedBy: null,
    lastRoundTurnsLeft: 0,
    doshAnnouncerPlayedTurn: false,

    // Poderes especiales: Q, J y Jokers
    pendingDiscardPower: null,
    qChainActive: false,
    qOriginPlayerIndex: null,
    jPowerUsable: false,
    jokerBlackBlocked: false,
    tableCardMatchedThisTurn: false,

    // Estado general: "idle" | "dealing" | "peeking" | "playing" | "dosh" | "ended"
    gameStatus: "idle",

    // Solo con significado en el navegador (modo local u online):
    isOnline: false,
    myPlayerIndex: 0,

    // Fase de memoria inicial
    peekPhase: {
      active:           false,
      currentPeekerIndex: 0,
      cardsLeftToReveal:  0,
      revealedThisPeek:   [],
    },
  };

  // ── Inicializar partida ─────────────────────────────────────────────────────

  /**
   * Inicializa una partida nueva: crea jugadores, baraja y reparte.
   *
   * @param {Array|string[]} playerNames - Nombres (o {name, isBot, id}) de los jugadores
   * @param {number} cardsPerPlayer - Cartas a repartir (debe ser par)
   * @param {Array|null} customDeck - Mazo pregenerado (online ya no se usa; el servidor reparte localmente)
   * @param {boolean} isOnline - Modo online
   * @param {number} myPlayerIndex - Índice de MI jugador (solo cliente)
   * @returns {{ success: boolean, error: string|null }}
   */
  function initGame(playerNames, cardsPerPlayer, customDeck = null, isOnline = false, myPlayerIndex = 0) {
    const playerValidation = validatePlayerCount(playerNames.length);
    if (!playerValidation.valid) return { success: false, error: playerValidation.error };

    const cardsValidation = validateCardsPerPlayer(cardsPerPlayer, playerNames.length);
    if (!cardsValidation.valid) return { success: false, error: cardsValidation.error };

    // Verificar que haya cartas suficientes (deben sobrar para robar)
    const totalCardsNeeded = playerNames.length * cardsPerPlayer;
    if (totalCardsNeeded >= 54) {
      return {
        success: false,
        error: `No hay cartas suficientes. Se necesitan ${totalCardsNeeded} pero la baraja tiene 54 y deben sobrar cartas para robar.`,
      };
    }

    // Resetear estado
    state.playerCount    = playerNames.length;
    state.cardsPerPlayer = cardsPerPlayer;
    state.isOnline       = isOnline;
    state.myPlayerIndex  = myPlayerIndex;
    state.players        = [];
    state.discardPile    = [];
    state.tableHistory   = [];
    state.activeTableCard = null;
    state.drawnCard      = null;
    state.drawnFromTable = false;
    state.doshAnnouncedBy = null;
    state.lastRoundTurnsLeft = 0;
    state.doshAnnouncerPlayedTurn = false;
    state.pendingDiscardPower = null;
    state.qChainActive   = false;
    state.qOriginPlayerIndex = null;
    state.jPowerUsable   = false;
    state.jokerBlackBlocked = false;
    state.tableCardMatchedThisTurn = false;
    state.currentPlayerIndex = 0;
    state.turnId         = 0;
    state.gameStatus     = "dealing";

    // Crear jugadores
    for (let i = 0; i < playerNames.length; i++) {
      const pInfo = typeof playerNames[i] === 'object' && playerNames[i] !== null
        ? playerNames[i]
        : { name: playerNames[i], isBot: false };
      const p = Player.createPlayer(i, pInfo.name);
      p.isBot = !!pInfo.isBot;
      p.botId = pInfo.id || null;
      state.players.push(p);
    }

    // Crear y barajar mazo (el servidor autoritativo baraja; el cliente no ejecuta esto)
    state.deck = customDeck ? [...customDeck] : Deck.shuffleDeck(Deck.createDeck());

    // Repartir cartas
    dealCards();

    // Iniciar fase de memoria
    startPeekPhase();

    return { success: true, error: null };
  }

  // ── Reparto ──────────────────────────────────────────────────────────────────

  function dealCards() {
    for (let round = 0; round < state.cardsPerPlayer; round++) {
      for (const player of state.players) {
        const card = Deck.drawCard(state.deck);
        if (card) {
          Player.addCardToHand(player, card, false, false);
        }
      }
    }
  }

  // ── Fase de memoria (mirar la mitad) ────────────────────────────────────────

  /**
   * Inicia la fase donde cada jugador mira la mitad de sus cartas.
   * En LOCAL es secuencial: se recorre jugador por jugador (pasa el dispositivo).
   * En ONLINE cada jugador mira en paralelo en su pantalla (el servidor gestiona
   * la fase con PEEK_REVEAL / PEEK_DONE a través de room y no con esta fase secuencial,
   * pero el estado peeking marca el inicio).
   */
  function startPeekPhase() {
    state.gameStatus = "peeking";
    state.peekPhase = {
      active:             true,
      currentPeekerIndex: 0,
      cardsLeftToReveal:  state.cardsPerPlayer / 2,
      revealedThisPeek:   [],
    };
  }

  /** Envía la partida directamente a la fase de juego (transición del servidor online). */
  function startPlayingPhase() {
    state.peekPhase = {
      active:             false,
      currentPeekerIndex: 0,
      cardsLeftToReveal:  0,
      revealedThisPeek:   [],
    };
    state.gameStatus = "playing";
    state.turnId += 1;
    state.currentPlayerIndex = 0;
  }

  function getCurrentPeeker() {
    return state.players[state.peekPhase.currentPeekerIndex];
  }

  /**
   * El jugador actual selecciona una carta para mirarla (fase secuencial local).
   *
   * @param {number} slotIndex - Posición en la mano del jugador
   * @returns {{ success: boolean, error: string|null }}
   */
  function peekCard(slotIndex) {
    const peek   = state.peekPhase;
    const player = getCurrentPeeker();

    if (!peek.active) return { success: false, error: "No estamos en la fase de memoria." };
    if (peek.cardsLeftToReveal <= 0) return { success: false, error: "Ya miraste todas las cartas que puedes." };
    if (peek.revealedThisPeek.includes(slotIndex)) return { success: false, error: "Ya miraste esa carta." };
    if (!player.hand[slotIndex]) return { success: false, error: "Posición inválida." };

    Player.revealCard(player, slotIndex);
    peek.revealedThisPeek.push(slotIndex);
    peek.cardsLeftToReveal--;

    return { success: true, error: null };
  }

  /**
   * Termina el peek del jugador actual (local) y pasa al siguiente.
   *
   * @returns {{ peekPhaseEnded: boolean }}
   */
  function finishPeeking() {
    const peek   = state.peekPhase;
    const player = getCurrentPeeker();

    Player.hideAllCards(player);

    peek.currentPeekerIndex++;
    peek.revealedThisPeek  = [];
    peek.cardsLeftToReveal = state.cardsPerPlayer / 2;

    if (peek.currentPeekerIndex >= state.players.length) {
      peek.active      = false;
      state.gameStatus = "playing";
      return { peekPhaseEnded: true };
    }

    return { peekPhaseEnded: false };
  }

  // ── Consultas de estado ─────────────────────────────────────────────────────

  /** @returns {Object} El jugador cuyo turno es ahora */
  function getCurrentPlayer() {
    return state.players[state.currentPlayerIndex];
  }

  /** @returns {number} Cartas restantes por mirar en la fase inicial */
  function getCardsLeftToPeek() {
    return state.peekPhase.cardsLeftToReveal;
  }

  // ── Utilidades de mesa ──────────────────────────────────────────────────────

  /**
   * Cuando se acaban las cartas del mazo, revuelve todas las cartas
   * que hay acumuladas en la mesa para formar un nuevo mazo.
   *
   * @returns {boolean}
   */
  function reshuffleTableIntoDeck() {
    const cards = [...state.tableHistory];
    if (state.activeTableCard && !cards.includes(state.activeTableCard)) {
      cards.push(state.activeTableCard);
    }

    if (cards.length === 0) return false;

    cards.forEach(c => {
      c.faceUp = false;
    });

    Deck.shuffleDeck(cards);
    state.deck.push(...cards);
    state.tableHistory = [];
    state.activeTableCard = null;
    return true;
  }

  /**
   * El jugador toma la carta que ya está descubierta en la mesa para interactuar con ella.
   *
   * @returns {{ success: boolean, card: Object|null, error: string|null }}
   */
  function useTableCardForCurrentPlayer() {
    if (state.gameStatus !== "playing" && state.gameStatus !== "dosh") {
      return { success: false, card: null, error: "La partida no está en curso." };
    }
    if (!state.activeTableCard) {
      return { success: false, card: null, error: "No hay ninguna carta en la mesa para tomar." };
    }
    if (state.drawnCard !== null) {
      return { success: false, card: null, error: "Ya tienes una carta en juego." };
    }

    // Si en este turno ya hizo copia con la carta de la mesa, no puede cambiarla
    if (state.tableCardMatchedThisTurn) {
      return { success: false, card: null, error: "Ya hiciste copia con la carta de la mesa en este turno. Solo puedes voltear del mazo." };
    }

    // Los Jokers que están en la mesa no se pueden cambiar por ningún jugador
    if (state.activeTableCard.rank === "JOKER") {
      return { success: false, card: null, error: "Los Jokers de la mesa no se pueden cambiar." };
    }

    // Si había una cadena de Q y decide usar la carta de la mesa, se rompe la cadena
    state.qChainActive = false;
    state.qOriginPlayerIndex = null;

    state.drawnCard      = state.activeTableCard;
    state.drawnFromTable = true;
    return { success: true, card: state.drawnCard, error: null };
  }

  /**
   * El jugador voltea una nueva carta del mazo.
   *
   * @returns {{ success: boolean, card: Object|null, reshuffled: boolean, error: string|null }}
   */
  function drawCardForCurrentPlayer() {
    if (state.gameStatus !== "playing" && state.gameStatus !== "dosh") {
      return { success: false, card: null, reshuffled: false, error: "La partida no está en curso." };
    }
    if (state.drawnCard !== null) {
      return { success: false, card: null, reshuffled: false, error: "Ya tienes una carta en juego. Debes decidir qué hacer con ella." };
    }

    let reshuffled = false;
    if (state.deck.length === 0) {
      reshuffled = reshuffleTableIntoDeck();
    }

    if (state.deck.length === 0) {
      return { success: false, card: null, reshuffled: false, error: "No quedan cartas en la baraja ni en la mesa." };
    }

    const card = Deck.drawCard(state.deck);
    state.drawnCard      = card;
    state.drawnFromTable = false;
    state.jokerBlackBlocked = false;
    state.tableCardMatchedThisTurn = false;

    // Si roba del mazo y no es una Q, se rompe la cadena de ver carta de la Q
    if (card.rank !== "Q") {
      state.qChainActive = false;
      state.qOriginPlayerIndex = null;
    }

    // La J volteada del mazo sí permite usar su poder
    state.jPowerUsable = (card.rank === "J");

    return { success: true, card: card, reshuffled: reshuffled, error: null };
  }

  /**
   * Acción: Dejarla.
   * La carta actual queda visible en la mesa para el siguiente jugador y termina el turno.
   *
   * @returns {{ success: boolean, discarded: Object|null, error: string|null }}
   */
  function discardDrawnCard() {
    if (!state.drawnCard) {
      return { success: false, discarded: null, error: "No hay carta activa para dejar." };
    }

    const leftCard = state.drawnCard;
    // Si la carta vino de la mesa ya está en el historial: no duplicarla
    if (!state.tableHistory.includes(leftCard)) {
      state.tableHistory.push(leftCard);
    }
    state.activeTableCard = leftCard;
    state.drawnCard = null;
    state.drawnFromTable = false;
    state.jPowerUsable = false;

    // Si no se usó el poder de la Q, se rompe la cadena
    if (state.qChainActive && state.currentPlayerIndex === state.qOriginPlayerIndex) {
      state.qChainActive = false;
      state.qOriginPlayerIndex = null;
    }

    nextTurn();

    return { success: true, discarded: leftCard, error: null };
  }

  /**
   * Acción: Cambiarla (Reemplazar una carta de la mano por la carta activa).
   * La carta que saca de su mano queda descubierta en la mesa para el siguiente jugador.
   *
   * @param {number} slotIndex - Posición de la carta en la mano del jugador
   * @returns {{ success: boolean, oldCard: Object|null, pendingPower: string|null, error: string|null }}
   */
  function replaceCardWithDrawn(slotIndex) {
    if (!state.drawnCard) {
      return { success: false, oldCard: null, pendingPower: null, error: "No hay carta activa para cambiar." };
    }

    const player = getCurrentPlayer();
    if (!player.hand[slotIndex]) {
      return { success: false, oldCard: null, pendingPower: null, error: "Posición inválida en la mano." };
    }

    const takenCard = state.drawnCard;
    const oldCard = Player.replaceCardInHand(player, slotIndex, takenCard);

    // Si la carta activa se tomó de la mesa, se retira del historial de la mesa
    if (state.drawnFromTable) {
      const idx = state.tableHistory.lastIndexOf(takenCard);
      if (idx !== -1) {
        state.tableHistory.splice(idx, 1);
      }
    }

    // La carta que sacó de su baraja queda descubierta en la mesa como la superior
    state.tableHistory.push(oldCard);
    state.activeTableCard = oldCard;
    state.drawnCard = null;
    state.drawnFromTable = false;

    // Cambiar una carta rompe el poder previo de J y la cadena de Q
    state.jPowerUsable = false;
    state.qChainActive = false;
    state.qOriginPlayerIndex = null;

    // Comprobar si la carta que el jugador botó a la mesa tiene poder especial
    if (oldCard.rank === "Q") {
      state.pendingDiscardPower = { type: "Q", card: oldCard };
      return { success: true, oldCard: oldCard, pendingPower: "Q", error: null };
    } else if (oldCard.rank === "J") {
      state.pendingDiscardPower = { type: "J", card: oldCard };
      return { success: true, oldCard: oldCard, pendingPower: "J", error: null };
    } else if (oldCard.rank === "JOKER" && oldCard.color === "red") {
      state.pendingDiscardPower = { type: "JOKER_RED", card: oldCard };
      return { success: true, oldCard: oldCard, pendingPower: "JOKER_RED", error: null };
    } else if (oldCard.rank === "JOKER" && oldCard.color === "black") {
      state.pendingDiscardPower = { type: "JOKER_BLACK", card: oldCard };
      return { success: true, oldCard: oldCard, pendingPower: "JOKER_BLACK", error: null };
    }

    // Si no tiene poder especial, termina el turno normalmente
    state.pendingDiscardPower = null;
    nextTurn();

    return { success: true, oldCard: oldCard, pendingPower: null, error: null };
  }

  /**
   * Permite omitir un poder opcional (Q o J) derivado de un cambio de carta y pasar el turno.
   * Los Jokers no se pueden omitir (son obligatorios).
   *
   * @returns {{ success: boolean, error: string|null }}
   */
  function skipPendingPower() {
    if (!state.pendingDiscardPower) {
      return { success: false, error: "No hay poder pendiente para omitir." };
    }
    if (state.pendingDiscardPower.type === "JOKER_RED" || state.pendingDiscardPower.type === "JOKER_BLACK") {
      return { success: false, error: "Los poderes del Joker son obligatorios y no se pueden omitir." };
    }

    state.pendingDiscardPower = null;
    nextTurn();
    return { success: true, error: null };
  }

  /**
   * Rompe la cadena de la Q si el jugador decide no ver una carta.
   *
   * @returns {{ success: boolean }}
   */
  function breakQChain() {
    state.qChainActive = false;
    state.qOriginPlayerIndex = null;
    return { success: true };
  }

  /**
   * Poder de la Q: Ver una carta propia (5 segundos en pantalla a cargo del cliente).
   *
   * @param {number} slotIndex - Posición de la carta en la mano que desea ver
   * @returns {{ success: boolean, card: Object|null, slotIndex: number, error: string|null }}
   */
  function useQPower(slotIndex) {
    const isFromDrawn = state.drawnCard && state.drawnCard.rank === "Q";
    const isFromPending = state.pendingDiscardPower && state.pendingDiscardPower.type === "Q";
    const isFromChain = state.qChainActive && state.activeTableCard && state.activeTableCard.rank === "Q" && state.currentPlayerIndex !== state.qOriginPlayerIndex;

    if (!isFromDrawn && !isFromPending && !isFromChain) {
      return { success: false, card: null, slotIndex: -1, error: "El poder de la Q no está disponible." };
    }

    const player = getCurrentPlayer();
    if (!player || !player.hand[slotIndex]) {
      return { success: false, card: null, slotIndex: -1, error: "Posición inválida en la mano." };
    }

    const slot = player.hand[slotIndex];
    slot.known = true; // El jugador ahora conoce su carta

    // Si vino de carta volteada del mazo, pasa a la mesa
    if (state.drawnCard) {
      if (!state.tableHistory.includes(state.drawnCard)) {
        state.tableHistory.push(state.drawnCard);
      }
      state.activeTableCard = state.drawnCard;
      state.drawnCard = null;
      state.drawnFromTable = false;
    }

    // Si el originador usó la Q (del mazo o de cambio), se activa la cadena para los demás
    if (isFromDrawn || isFromPending) {
      state.qChainActive = true;
      state.qOriginPlayerIndex = state.currentPlayerIndex;
    }
    // Si venía de la cadena (isFromChain), la cadena se mantiene activa hacia el siguiente jugador

    state.pendingDiscardPower = null;
    state.jPowerUsable = false;

    nextTurn();

    return { success: true, card: slot.card, slotIndex: slotIndex, error: null };
  }

  /**
   * Poder de la J: Intercambiar una carta propia por una de cualquier otro jugador (boca abajo).
   *
   * @param {number} mySlotIndex - Índice de la carta propia
   * @param {number} targetPlayerIndex - Índice del jugador rival
   * @param {number} targetSlotIndex - Índice de la carta del jugador rival
   * @returns {{ success: boolean, myCard: Object|null, targetCard: Object|null, error: string|null }}
   */
  function useJPower(mySlotIndex, targetPlayerIndex, targetSlotIndex) {
    const isFromDrawn = state.jPowerUsable && state.drawnCard && state.drawnCard.rank === "J";
    const isFromPending = state.pendingDiscardPower && state.pendingDiscardPower.type === "J";

    if (!isFromDrawn && !isFromPending) {
      return { success: false, myCard: null, targetCard: null, error: "El poder de la J no está disponible en este momento." };
    }

    const currentPlayer = getCurrentPlayer();
    const targetPlayer = state.players[targetPlayerIndex];

    if (!targetPlayer || targetPlayer.id === currentPlayer.id) {
      return { success: false, myCard: null, targetCard: null, error: "Debes seleccionar a otro jugador." };
    }

    if (!currentPlayer.hand[mySlotIndex] || !targetPlayer.hand[targetSlotIndex]) {
      return { success: false, myCard: null, targetCard: null, error: "Posición inválida en la mano." };
    }

    const res = Player.swapCardsBetweenPlayers(currentPlayer, mySlotIndex, targetPlayer, targetSlotIndex);
    if (!res.success) {
      return { success: false, myCard: null, targetCard: null, error: res.error };
    }

    // Si venía de una J volteada del mazo, pasa a la mesa
    if (state.drawnCard) {
      if (!state.tableHistory.includes(state.drawnCard)) {
        state.tableHistory.push(state.drawnCard);
      }
      state.activeTableCard = state.drawnCard;
      state.drawnCard = null;
      state.drawnFromTable = false;
    }

    state.pendingDiscardPower = null;
    state.jPowerUsable = false;
    state.qChainActive = false;
    state.qOriginPlayerIndex = null;

    nextTurn();

    return {
      success: true,
      myCard: res.cardA,
      targetCard: res.cardB,
      error: null,
    };
  }

  /**
   * Poder del Joker Rojo (OBLIGATORIO):
   * El jugador quita cualquier carta de su baraja y esa carta queda encima de la mesa.
   *
   * @param {number} slotIndex - Posición de la carta de la mano a descartar
   * @returns {{ success: boolean, removedCard: Object|null, gameEnded: boolean, winner: Object|null, error: string|null }}
   */
  function useJokerRedPower(slotIndex) {
    const isFromDrawn = state.drawnCard && state.drawnCard.rank === "JOKER" && state.drawnCard.color === "red";
    const isFromPending = state.pendingDiscardPower && state.pendingDiscardPower.type === "JOKER_RED";

    if (!isFromDrawn && !isFromPending) {
      return { success: false, removedCard: null, gameEnded: false, winner: null, error: "No tienes el Joker Rojo activo." };
    }

    const player = getCurrentPlayer();
    if (!player || !player.hand[slotIndex] || !player.hand[slotIndex].card) {
      return { success: false, removedCard: null, gameEnded: false, winner: null, error: "Posición inválida en la mano." };
    }

    // Quitar la carta elegida de su baraja
    const removedCard = Player.removeCardFromHand(player, slotIndex);

    // Si vino del mazo, poner el Joker Rojo en el historial de la mesa
    if (state.drawnCard) {
      const redJoker = state.drawnCard;
      state.tableHistory.push(redJoker);
      state.drawnCard = null;
      state.drawnFromTable = false;
    }

    // La carta quitada de su baraja queda descubierta encima del Joker Rojo en la mesa
    state.tableHistory.push(removedCard);
    state.activeTableCard = removedCard;

    state.pendingDiscardPower = null;
    state.jPowerUsable = false;
    state.qChainActive = false;
    state.qOriginPlayerIndex = null;

    // Si llega a 0 cartas, gana inmediatamente
    if (player.hand.length === 0) {
      state.gameStatus = "ended";
      return { success: true, removedCard: removedCard, gameEnded: true, winner: player, error: null };
    }

    nextTurn();

    return { success: true, removedCard: removedCard, gameEnded: false, winner: null, error: null };
  }

  /**
   * Poder del Joker Negro (OBLIGATORIO):
   * El jugador elige a un rival para que se coma 2 cartas del mazo.
   * El turno pasa automáticamente a ese rival elegido.
   *
   * @param {number} targetPlayerIndex - Índice del jugador rival elegido
   * @returns {{ success: boolean, targetPlayer: Object|null, penalties: Array<Object>, error: string|null }}
   */
  function useJokerBlackPower(targetPlayerIndex) {
    const isFromDrawn = state.drawnCard && state.drawnCard.rank === "JOKER" && state.drawnCard.color === "black";
    const isFromPending = state.pendingDiscardPower && state.pendingDiscardPower.type === "JOKER_BLACK";

    if (!isFromDrawn && !isFromPending) {
      return { success: false, targetPlayer: null, penalties: [], error: "No tienes el Joker Negro activo." };
    }

    const currentPlayer = getCurrentPlayer();
    const targetPlayer = state.players[targetPlayerIndex];

    if (!targetPlayer || targetPlayer.id === currentPlayer.id) {
      return { success: false, targetPlayer: null, penalties: [], error: "Debes elegir a otro jugador." };
    }

    // Dar 2 cartas de penalización al rival
    const penalties = [];
    for (let i = 0; i < 2; i++) {
      if (state.deck.length === 0) {
        reshuffleTableIntoDeck();
      }
      const penaltyCard = Deck.drawCard(state.deck);
      if (penaltyCard) {
        Player.addCardToHand(targetPlayer, penaltyCard, false, false, true);
        targetPlayer.penaltyCount = (targetPlayer.penaltyCount || 0) + 1;
        penalties.push(penaltyCard);
      }
    }

    // Si vino del mazo, el Joker Negro queda en la mesa
    if (state.drawnCard) {
      const blackJoker = state.drawnCard;
      state.tableHistory.push(blackJoker);
      state.activeTableCard = blackJoker;
      state.drawnCard = null;
      state.drawnFromTable = false;
    }

    state.pendingDiscardPower = null;
    state.jPowerUsable = false;
    state.qChainActive = false;
    state.qOriginPlayerIndex = null;

    // El turno pasa automáticamente al jugador elegido (cambio de turno → nuevo turnId)
    state.currentPlayerIndex = targetPlayerIndex;
    state.jPowerUsable = false;
    state.jokerBlackBlocked = true;
    state.tableCardMatchedThisTurn = false;
    state.turnId += 1;

    // Si la cadena de Q estaba activa y volvió al originador se rompe (el originador no puede ser el castigado aquí)
    if (state.qChainActive && state.currentPlayerIndex === state.qOriginPlayerIndex) {
      state.qChainActive = false;
      state.qOriginPlayerIndex = null;
    }

    return { success: true, targetPlayer: targetPlayer, penalties: penalties, error: null };
  }

  /**
   * Cantar ¡DOSH! — todos los demás jugadores tendrán exactamente un último turno.
   *
   * @returns {{ success: boolean, player: Object|null, turnsLeft: number, error: string|null }}
   */
  function announceDosh() {
    if (state.doshAnnouncedBy !== null) {
      return { success: false, player: null, turnsLeft: 0, error: "¡DOSH ya ha sido cantado!" };
    }

    const player = getCurrentPlayer();
    state.doshAnnouncedBy = state.currentPlayerIndex;
    state.lastRoundTurnsLeft = state.players.length - 1;
    state.gameStatus = "dosh";
    state.doshAnnouncerPlayedTurn = false;

    return {
      success: true,
      player: player,
      turnsLeft: state.lastRoundTurnsLeft,
      error: null,
    };
  }

  /**
   * Acción: Hacer copia (Emparejar).
   * - Si coincide: se une a la mesa y se reduce una carta.
   * - Si NO coincide: conserva su carta y se come una carta del mazo sin verla (+1 carta).
   *
   * @param {number} slotIndex - Posición de la carta elegida en la mano
   * @returns {{ success: boolean, matched: boolean, removedCard: Object|null, revealedCard: Object|null, penaltyCard: Object|null, gameEnded: boolean, winner: Object|null, error: string|null }}
   */
  function matchCardWithDrawn(slotIndex) {
    if (!state.drawnCard) {
      return { success: false, matched: false, removedCard: null, revealedCard: null, penaltyCard: null, gameEnded: false, winner: null, error: "No hay carta activa para hacer copia." };
    }

    const player = getCurrentPlayer();
    if (!player.hand[slotIndex] || !player.hand[slotIndex].card) {
      return { success: false, matched: false, removedCard: null, revealedCard: null, penaltyCard: null, gameEnded: false, winner: null, error: "Posición inválida en la mano." };
    }

    const isMatch = (typeof Rules !== "undefined" && Rules.areMatchingCards)
      ? Rules.areMatchingCards(state.drawnCard, player.hand[slotIndex].card)
      : (player.hand[slotIndex].card.rank === state.drawnCard.rank);

    if (isMatch) {
      // ── Coincidencia exitosa ──
      const removedCard = Player.removeCardFromHand(player, slotIndex);
      const matchedRank = removedCard.rank;

      // Ambas cartas se incorporan al historial de la mesa
      if (!state.tableHistory.includes(state.drawnCard)) {
        state.tableHistory.push(state.drawnCard);
      }
      state.tableHistory.push(removedCard);
      state.activeTableCard = removedCard;

      const wasFromTable = state.drawnFromTable;
      state.drawnCard      = null;
      state.drawnFromTable = false;

      // Si llega a 0 cartas, gana inmediatamente
      if (player.hand.length === 0) {
        state.gameStatus = "ended";
        return { success: true, matched: true, removedCard: removedCard, revealedCard: null, penaltyCard: null, gameEnded: true, winner: player, drawnFromTable: wasFromTable, matchedRank: matchedRank, error: null };
      }

      // Si emparejó una J, puede usar el poder de la J
      state.jPowerUsable = (matchedRank === "J");

      // Si emparejó una Q, inicia o reinicia la cadena de la Q con este jugador
      if (matchedRank === "Q") {
        state.qChainActive = true;
        state.qOriginPlayerIndex = state.currentPlayerIndex;
      }

      // Si la copia fue exitosa usando la carta de la mesa, el jugador sigue en su turno
      if (wasFromTable) {
        state.tableCardMatchedThisTurn = true;
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
      const slot = player.hand[slotIndex];
      const revealedCard = slot.card;
      slot.known = true; // El jugador ahora conoce la carta porque la reveló

      // Penalización: se come una carta del mazo sin verla
      if (state.deck.length === 0) {
        reshuffleTableIntoDeck();
      }
      const penaltyCard = Deck.drawCard(state.deck);
      if (penaltyCard) {
        Player.addCardToHand(player, penaltyCard, false, false, true);
        player.penaltyCount = (player.penaltyCount || 0) + 1;
      }

      // La carta activa queda en la mesa para el siguiente jugador
      if (!state.tableHistory.includes(state.drawnCard)) {
        state.tableHistory.push(state.drawnCard);
      }
      state.activeTableCard = state.drawnCard;

      const wasFromTable = state.drawnFromTable;
      state.drawnCard      = null;
      state.drawnFromTable = false;
      state.jPowerUsable   = false;
      state.qChainActive   = false;
      state.qOriginPlayerIndex = null;

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
   * Avanza el turno al siguiente jugador (único punto de avance).
   * Incrementa turnId para detectar acciones atrasadas/duplicadas.
   *
   * @returns {Object} El nuevo jugador activo
   */
  function nextTurn() {
    if (state.doshAnnouncedBy !== null && state.gameStatus === "dosh") {
      if (!state.doshAnnouncerPlayedTurn) {
        // El jugador que cantó DOSH terminó de jugar su turno, ahora inician los demás
        state.doshAnnouncerPlayedTurn = true;
      } else {
        // Uno de los demás jugadores terminó su último turno
        state.lastRoundTurnsLeft--;
        if (state.lastRoundTurnsLeft <= 0) {
          state.gameStatus = "ended";
          return getCurrentPlayer();
        }
      }
    }

    state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
    state.jPowerUsable = false;
    state.jokerBlackBlocked = false;
    state.tableCardMatchedThisTurn = false;
    state.turnId += 1;

    // Si la cadena de Q estaba activa y volvió al originador, se termina la cadena
    if (state.qChainActive && state.currentPlayerIndex === state.qOriginPlayerIndex) {
      state.qChainActive = false;
      state.qOriginPlayerIndex = null;
    }

    return getCurrentPlayer();
  }

  /**
   * Calcula las puntuaciones finales (solo se usa al terminar la partida).
   *
   * @returns {Array<{ player: Object, score: number, cardCount: number, isWinner: boolean }>}
   */
  function calculateFinalScores() {
    const results = state.players.map((p) => {
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

  return {
    state,
    initGame,
    validateCardsPerPlayer,
    validatePlayerCount,
    startPlayingPhase,
    getCurrentPeeker,
    peekCard,
    finishPeeking,
    getCurrentPlayer,
    getCardsLeftToPeek,
    reshuffleTableIntoDeck,
    useTableCardForCurrentPlayer,
    drawCardForCurrentPlayer,
    discardDrawnCard,
    replaceCardWithDrawn,
    skipPendingPower,
    breakQChain,
    useQPower,
    useJPower,
    useJokerRedPower,
    useJokerBlackPower,
    announceDosh,
    calculateFinalScores,
    matchCardWithDrawn,
    nextTurn,
  };
}

// ─── Instancia por defecto (navegador / modo local) ─────────────────────────────

const defaultGame = createGame();

const gameState = defaultGame.state; // Compatibilidad con código existente

const Game = {
  gameState,
  state: gameState,
  initGame:        (...a) => defaultGame.initGame(...a),
  validateCardsPerPlayer,
  validatePlayerCount,
  getCurrentPeeker:        () => defaultGame.getCurrentPeeker(),
  peekCard:                (...a) => defaultGame.peekCard(...a),
  finishPeeking:           () => defaultGame.finishPeeking(),
  getCurrentPlayer:        () => defaultGame.getCurrentPlayer(),
  getCardsLeftToPeek:      () => defaultGame.getCardsLeftToPeek(),
  useTableCardForCurrentPlayer: () => defaultGame.useTableCardForCurrentPlayer(),
  drawCardForCurrentPlayer:     () => defaultGame.drawCardForCurrentPlayer(),
  reshuffleTableIntoDeck:       () => defaultGame.reshuffleTableIntoDeck(),
  discardDrawnCard:         () => defaultGame.discardDrawnCard(),
  replaceCardWithDrawn:    (...a) => defaultGame.replaceCardWithDrawn(...a),
  skipPendingPower:         () => defaultGame.skipPendingPower(),
  breakQChain:              () => defaultGame.breakQChain(),
  useQPower:               (...a) => defaultGame.useQPower(...a),
  useJPower:               (...a) => defaultGame.useJPower(...a),
  useJokerRedPower:        (...a) => defaultGame.useJokerRedPower(...a),
  useJokerBlackPower:      (...a) => defaultGame.useJokerBlackPower(...a),
  announceDosh:             () => defaultGame.announceDosh(),
  calculateFinalScores:     () => defaultGame.calculateFinalScores(),
  matchCardWithDrawn:      (...a) => defaultGame.matchCardWithDrawn(...a),
  nextTurn:                 () => defaultGame.nextTurn(),
};

// ─── Exportar ─────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Game, createGame, gameState };
} else {
  // En el navegador, el objeto global Game (declared const arriba) queda accesible.
}
