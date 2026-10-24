/**
 * player.js
 * Estructura y lógica de cada jugador del juego DOS.
 *
 * Responsabilidades:
 *  - Crear jugadores
 *  - Gestionar la mano (cartas del jugador)
 *  - Registrar qué cartas conoce el jugador y cuáles no
 *  - Agregar, quitar y reemplazar cartas
 *
 * NO contiene lógica de turnos, reglas ni interfaz.
 */

// ─── Crear un jugador ─────────────────────────────────────────────────────────

/**
 * Crea un nuevo jugador con una mano vacía.
 *
 * @param {number} id   - Índice del jugador (0, 1, 2…)
 * @param {string} name - Nombre del jugador
 * @returns {Object} Objeto jugador
 */
function createPlayer(id, name) {
  return {
    id:   id,
    name: name,

    /**
     * Mano del jugador: array de slots.
     * Cada slot representa una posición en la mesa del jugador.
     *
     * Estructura de un slot:
     * {
     *   card:    Object|null,  // La carta real (solo el servidor la conoce en multijugador)
     *   known:   boolean,      // ¿El jugador sabe qué carta es?
     *   faceUp:  boolean,      // ¿Está visible en pantalla ahora mismo?
     * }
     *
     * Nota de diseño (preparación para multijugador):
     * En la versión online, los demás jugadores solo ven
     * { known: false, faceUp: false } de tus cartas.
     * El campo "card" nunca se envía a otros clientes.
     */
    hand: [],

    // Estado del jugador en la ronda
    isEliminated: false,  // Para futuras rondas multi-ronda
    penaltyCount: 0,      // Cartas de penalización recibidas en la ronda
  };
}

// ─── Gestión de la mano ───────────────────────────────────────────────────────

/**
 * Agrega una carta a la mano del jugador en una nueva posición.
 * La carta llega boca abajo y desconocida por defecto.
 *
 * @param {Object}  player      - El jugador
 * @param {Object}  card        - La carta a agregar
 * @param {boolean} known       - Si el jugador ya sabe qué carta es (default: false)
 * @param {boolean} faceUp      - Si debe mostrarse boca arriba ahora (default: false)
 * @param {boolean} atBeginning - Si debe agregarse al inicio (a la izquierda) de la mano (default: false)
 */
function addCardToHand(player, card, known = false, faceUp = false, atBeginning = false) {
  const slot = {
    card:   card,
    known:  known,
    faceUp: faceUp,
  };

  if (atBeginning) {
    player.hand.unshift(slot);
  } else {
    player.hand.push(slot);
  }
}

/**
 * Quita y devuelve la carta de una posición específica de la mano.
 * Deja un slot vacío (null) en esa posición.
 *
 * @param {Object} player    - El jugador
 * @param {number} slotIndex - Posición en la mano (0-based)
 * @returns {Object|null} La carta retirada, o null si la posición está vacía
 */
function removeCardFromHand(player, slotIndex) {
  const slot = player.hand[slotIndex];
  if (!slot || slot.card === null) return null;

  const removedCard = slot.card;

  // Eliminamos el slot completamente del array
  player.hand.splice(slotIndex, 1);

  return removedCard;
}

/**
 * Reemplaza la carta de una posición por una nueva carta.
 * Devuelve la carta que estaba antes (para devolverla al mazo).
 *
 * La nueva carta llega conocida (el jugador la acaba de ver antes de colocarla)
 * pero vuelve a quedar boca abajo.
 *
 * @param {Object} player    - El jugador
 * @param {number} slotIndex - Posición a reemplazar
 * @param {Object} newCard   - La carta nueva
 * @returns {Object|null} La carta que estaba en esa posición, o null
 */
function replaceCardInHand(player, slotIndex, newCard) {
  const slot = player.hand[slotIndex];
  if (!slot) return null;

  const oldCard = slot.card;

  // La carta nueva es conocida porque el jugador la eligió conscientemente
  slot.card   = newCard;
  slot.known  = true;   // El jugador sabe qué puso ahí
  slot.faceUp = false;  // Pero vuelve a quedar boca abajo

  return oldCard;
}

/**
 * Marca una carta como "conocida" por el jugador (la miró).
 * No la muestra permanentemente; solo actualiza el estado interno.
 *
 * @param {Object} player    - El jugador
 * @param {number} slotIndex - Posición en la mano
 */
function markCardAsKnown(player, slotIndex) {
  const slot = player.hand[slotIndex];
  if (slot) slot.known = true;
}

/**
 * Muestra una carta boca arriba temporalmente (para que el jugador la vea).
 * Se usa durante la fase inicial y al activar la habilidad de la Q.
 *
 * @param {Object} player    - El jugador
 * @param {number} slotIndex - Posición en la mano
 */
function revealCard(player, slotIndex) {
  const slot = player.hand[slotIndex];
  if (slot) {
    slot.faceUp = true;
    slot.known  = true;
  }
}

/**
 * Oculta una carta (la vuelve boca abajo).
 *
 * @param {Object} player    - El jugador
 * @param {number} slotIndex - Posición en la mano
 */
function hideCard(player, slotIndex) {
  const slot = player.hand[slotIndex];
  if (slot) {
    slot.faceUp = false;
    if (slot.card) slot.card.faceUp = false;
  }
}

/**
 * Oculta TODAS las cartas del jugador.
 * Se usa al terminar la fase de "mirar" al inicio de la partida.
 *
 * @param {Object} player - El jugador
 */
function hideAllCards(player) {
  for (const slot of player.hand) {
    slot.faceUp = false;
    if (slot.card) slot.card.faceUp = false;
  }
}

// ─── Consultas sobre la mano ─────────────────────────────────────────────────

/**
 * Devuelve el número de cartas en la mano del jugador.
 *
 * @param {Object} player - El jugador
 * @returns {number}
 */
function getHandSize(player) {
  return player.hand.length;
}

/**
 * Calcula la suma real de puntos de la mano del jugador.
 * Solo se usa al final de la ronda (cuando se revelan todas las cartas).
 *
 * @param {Object} player - El jugador
 * @returns {number} Suma total de puntos
 */
function calculateHandValue(player) {
  return player.hand.reduce((total, slot) => {
    return total + (slot.card ? slot.card.value : 0);
  }, 0);
}

/**
 * Devuelve una vista "segura" de la mano para mostrar a OTROS jugadores.
 * Solo incluye si la carta está boca arriba o no.
 * NUNCA revela el valor de las cartas boca abajo.
 *
 * Esto es la base del diseño para multijugador:
 * esta función simula lo que el servidor enviaría a los demás clientes.
 *
 * @param {Object} player - El jugador
 * @returns {Array} Array de slots sin información privada
 */
function getPublicHandView(player) {
  return player.hand.map((slot) => ({
    faceUp: slot.faceUp,
    card:   slot.faceUp ? slot.card : null, // Solo se muestra si está boca arriba
  }));
}

/**
 * Intercambia una carta entre dos jugadores conservando exactamente las mismas posiciones (slots).
 * El slot del jugador A pasa al jugador B en su misma posición, y viceversa.
 * Las cartas vuelven a quedar boca abajo (faceUp = false) pero se preserva si el jugador las conoce.
 *
 * @param {Object} playerA  - Primer jugador
 * @param {number} slotA    - Índice del slot en la mano de playerA
 * @param {Object} playerB  - Segundo jugador
 * @param {number} slotB    - Índice del slot en la mano de playerB
 * @returns {boolean} Si el intercambio fue exitoso
 */
function swapCardsBetweenPlayers(playerA, slotA, playerB, slotB) {
  if (!playerA || !playerB || !playerA.hand[slotA] || !playerB.hand[slotB]) {
    return { success: false, cardA: null, cardB: null, error: "Posiciones o jugadores inválidos para el intercambio." };
  }

  const tempCard = playerA.hand[slotA].card;
  playerA.hand[slotA].card = playerB.hand[slotB].card;
  playerB.hand[slotB].card = tempCard;

  // Quedan boca abajo; ninguno conoce la carta que le llegó
  playerA.hand[slotA].faceUp = false;
  playerA.hand[slotA].known  = false;

  playerB.hand[slotB].faceUp = false;
  playerB.hand[slotB].known  = false;

  return { success: true, cardA: playerA.hand[slotA].card, cardB: playerB.hand[slotB].card, error: null };
}

// ─── Exportar ─────────────────────────────────────────────────────────────────

const Player = {
  createPlayer,
  addCardToHand,
  removeCardFromHand,
  replaceCardInHand,
  markCardAsKnown,
  revealCard,
  hideCard,
  hideAllCards,
  getHandSize,
  calculateHandValue,
  getPublicHandView,
  swapCardsBetweenPlayers,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Player;
}
