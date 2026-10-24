/**
 * rules.js
 * Centralización de las reglas oficiales y configuraciones del juego DOS.
 *
 * Responsabilidades:
 *  - Definir y calcular valores de puntuación de cartas.
 *  - Gestionar el valor modular/provisional de los Jokers (sin asumir 0).
 *  - Validar reglas de reparto (siempre número par).
 *  - Calcular dinámicamente el límite máximo de cartas según jugadores y baraja.
 *  - Reglas de coincidencias y acciones (preparado para las siguientes etapas).
 *
 * NO contiene lógica de interfaz ni manipulación de DOM.
 */

// ─── Configuración de reglas ──────────────────────────────────────────────────

const GAME_RULES = {
  TOTAL_DECK_CARDS: 54, // 52 estándar + 2 Jokers
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,       // Límite técnico provisional
  MIN_CARDS_PER_PLAYER: 2,
  
  // CONFIRMADO por el usuario: ambos Jokers valen 15 puntos.
  // (Configurable por si en el futuro se decide un valor distinto).
  JOKER_SCORE_VALUE: 15,
  
  // Tiempo de memoria en segundos
  PEEK_SECONDS: 10,
};

// ─── Valores de las cartas ────────────────────────────────────────────────────

/**
 * Obtiene el valor en puntos de una carta para el recuento de fin de partida.
 * 
 * Reglas confirmadas:
 *  - A = 1
 *  - 2 a 10 = su valor numérico
 *  - J = 11
 *  - Q = 12
 *  - K roja = 0
 *  - K negra = 13
 *  - Jokers = pendiente (se consulta la configuración modular)
 *
 * @param {Object} card - Objeto carta con { rank, color }
 * @returns {number|null} Puntos de la carta
 */
function getCardValue(card) {
  if (!card) return 0;
  
  if (card.rank === "JOKER") {
    return GAME_RULES.JOKER_SCORE_VALUE; // Confirmado: 15 puntos
  }

  switch (card.rank) {
    case "A":  return 1;
    case "J":  return 11;
    case "Q":  return 12;
    case "K":  return card.color === "red" ? 0 : 13;
    default:   return parseInt(card.rank, 10);
  }
}

/**
 * Permite configurar el valor de puntuación del Joker cuando se defina formalmente.
 * @param {number} value
 */
function setJokerScoreValue(value) {
  GAME_RULES.JOKER_SCORE_VALUE = value;
}

// ─── Validaciones de configuración ───────────────────────────────────────────

/**
 * Calcula el número máximo de cartas pares que se puede repartir por jugador,
 * garantizando que sea par y que queden cartas en la baraja para jugar.
 *
 * @param {number} playerCount - Número de jugadores
 * @param {number} totalCards  - Total de cartas en la baraja (default: 54)
 * @returns {number} Máximo número par permitido
 */
function calculateMaxCards(playerCount, totalCards = GAME_RULES.TOTAL_DECK_CARDS) {
  if (!playerCount || playerCount < 1) return GAME_RULES.MIN_CARDS_PER_PLAYER;
  
  // Dejamos al menos un margen de cartas en el mazo para poder robar (mínimo 2 cartas de reserva)
  const maxAvailable = Math.floor((totalCards - 2) / playerCount);
  // Redondear hacia abajo al número par más cercano
  const maxEven = maxAvailable % 2 === 0 ? maxAvailable : maxAvailable - 1;
  
  return Math.max(GAME_RULES.MIN_CARDS_PER_PLAYER, maxEven);
}

/**
 * Valida el número de cartas por jugador.
 * Debe ser un número par y no superar la capacidad de la baraja.
 *
 * @param {number} cardsCount  - Cartas deseadas por jugador
 * @param {number} playerCount - Cantidad de jugadores
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateCardsPerPlayer(cardsCount, playerCount) {
  if (!Number.isInteger(cardsCount) || cardsCount < GAME_RULES.MIN_CARDS_PER_PLAYER) {
    return {
      valid: false,
      error: `El número de cartas debe ser al menos ${GAME_RULES.MIN_CARDS_PER_PLAYER}.`,
    };
  }

  if (cardsCount % 2 !== 0) {
    return {
      valid: false,
      error: "El número de cartas debe ser un número par (2, 4, 6, 8...).",
    };
  }

  const maxCards = calculateMaxCards(playerCount);
  if (cardsCount > maxCards) {
    return {
      valid: false,
      error: `Para ${playerCount} jugadores, el máximo número par permitido es ${maxCards} cartas.`,
    };
  }

  const totalNeeded = cardsCount * playerCount;
  if (totalNeeded >= GAME_RULES.TOTAL_DECK_CARDS) {
    return {
      valid: false,
      error: `No hay suficientes cartas en la baraja. Se necesitan cartas sobrantes para robar.`,
    };
  }

  return { valid: true, error: null };
}

/**
 * Valida el número de jugadores según los límites técnicos vigentes.
 *
 * @param {number} playerCount
 * @returns {{ valid: boolean, error: string|null }}
 */
function validatePlayerCount(playerCount) {
  if (!Number.isInteger(playerCount) || playerCount < GAME_RULES.MIN_PLAYERS) {
    return {
      valid: false,
      error: `Debe haber al menos ${GAME_RULES.MIN_PLAYERS} jugadores.`,
    };
  }

  if (playerCount > GAME_RULES.MAX_PLAYERS) {
    return {
      valid: false,
      error: `El límite técnico actual es de ${GAME_RULES.MAX_PLAYERS} jugadores.`,
    };
  }

  return { valid: true, error: null };
}

// ─── Reglas de juego preparadas para siguientes etapas ───────────────────────

/**
 * Verifica si dos cartas coinciden para eliminación de pareja o robo de turno.
 * Los palos NO importan, solo el rango (ej. 3♥ coincide con 3♠).
 *
 * @param {Object} cardA
 * @param {Object} cardB
 * @returns {boolean}
 */
function areMatchingCards(cardA, cardB) {
  if (!cardA || !cardB) return false;
  if (cardA.rank !== cardB.rank) return false;

  // Regla especial de las K:
  // K negra solo coincide con K negra (13 pts), K roja solo con K roja (0 pts)
  if (cardA.rank === "K") {
    return cardA.color === cardB.color;
  }

  return true;
}

/**
 * Verifica si un slot de la mano puede ser reemplazado por la carta robada.
 * El jugador puede elegir cualquier carta de su mano (la conozca o no).
 *
 * @param {Object} slot - Slot del jugador { card, known, faceUp }
 * @returns {boolean}
 */
function canReplaceSlot(slot) {
  return Boolean(slot && slot.card);
}

/**
 * Verifica si la carta del slot coincide en valor/rango con la carta robada para eliminar pareja.
 *
 * @param {Object} drawnCard - Carta robada actualmente
 * @param {Object} slot      - Slot del jugador
 * @returns {boolean}
 */
function canMatchSlot(drawnCard, slot) {
  if (!drawnCard || !slot || !slot.card) return false;
  return areMatchingCards(drawnCard, slot.card);
}

// ─── Exportar ─────────────────────────────────────────────────────────────────

const Rules = {
  GAME_RULES,
  getCardValue,
  setJokerScoreValue,
  calculateMaxCards,
  validateCardsPerPlayer,
  validatePlayerCount,
  areMatchingCards,
  canReplaceSlot,
  canMatchSlot,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Rules;
}
