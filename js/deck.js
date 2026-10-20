/**
 * deck.js
 * Lógica de la baraja del juego DOS.
 *
 * Responsabilidades:
 *  - Definir la estructura de una carta
 *  - Crear la baraja completa de 54 cartas (52 + 2 Jokers)
 *  - Asignar valores según las reglas del juego
 *  - Barajar
 *
 * NO contiene lógica de interfaz ni de jugadores.
 */

// ─── Constantes ──────────────────────────────────────────────────────────────

const SUITS = [
  { name: "hearts",   color: "red"   },
  { name: "diamonds", color: "red"   },
  { name: "clubs",    color: "black" },
  { name: "spades",   color: "black" },
];

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

// ─── Valor de cada carta ─────────────────────────────────────────────────────

/**
 * Calcula el valor en puntos de una carta según las reglas del juego.
 *
 * Reglas especiales:
 *  - K roja  (hearts, diamonds) = 0 puntos
 *  - K negra (clubs, spades)    = 13 puntos
 *  - Q = 12 puntos (además tiene habilidad especial, se maneja en rules.js)
 *  - J = 11 puntos
 *  - A = 1 punto
 *  - 2–10 = su valor numérico
 *  - Jokers = valor 0 para puntuación (sus efectos se manejan en rules.js)
 *
 * @param {string} rank  - Rango de la carta ("A", "2"…"K", "JOKER")
 * @param {string} color - Color de la carta ("red" | "black")
 * @returns {number} Puntos de la carta
 */
function getCardValue(rank, color) {
  if (rank === "JOKER") return 0; // Sin valor de puntuación; su efecto es especial

  switch (rank) {
    case "A":  return 1;
    case "J":  return 11;
    case "Q":  return 12;
    case "K":  return color === "red" ? 0 : 13; // K roja = 0, K negra = 13
    default:   return parseInt(rank, 10);        // 2–10
  }
}

// ─── Crear la baraja ─────────────────────────────────────────────────────────

/**
 * Crea una baraja nueva y completa de 54 cartas.
 * Cada carta es un objeto inmutable con toda su información.
 *
 * @returns {Array<Object>} Array de 54 objetos-carta
 */
function createDeck() {
  const deck = [];

  // 52 cartas normales
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      const color = suit.color;
      const card = {
        id:          `${rank}_${suit.name}`,  // ej. "K_hearts", "7_clubs"
        rank:        rank,
        suit:        suit.name,
        value:       getCardValue(rank, color),
        color:       color,
        isSpecial:   rank === "Q",             // La Q tiene habilidad de mirar
        specialType: rank === "Q" ? "peek_own" : null,  // Se ampliará en Fase 3
      };
      deck.push(card);
    }
  }

  // Joker rojo
  deck.push({
    id:          "JOKER_red",
    rank:        "JOKER",
    suit:        "joker",
    value:       0,
    color:       "red",
    isSpecial:   true,
    specialType: "joker_red",   // Permite descartar cualquier carta (Fase 5)
  });

  // Joker negro
  deck.push({
    id:          "JOKER_black",
    rank:        "JOKER",
    suit:        "joker",
    value:       0,
    color:       "black",
    isSpecial:   true,
    specialType: "joker_black", // El jugador elegido roba 2 cartas (Fase 5)
  });

  return deck; // 54 cartas en total
}

// ─── Barajar ─────────────────────────────────────────────────────────────────

/**
 * Baraja un array de cartas usando el algoritmo Fisher-Yates.
 * Modifica el array original y también lo devuelve.
 *
 * @param {Array} deck - Array de cartas
 * @returns {Array} El mismo array barajado
 */
function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ─── Robar una carta ─────────────────────────────────────────────────────────

/**
 * Extrae y devuelve la primera carta del mazo.
 * Devuelve null si el mazo está vacío.
 *
 * @param {Array} deck - El mazo actual
 * @returns {Object|null} La carta robada o null
 */
function drawCard(deck) {
  if (deck.length === 0) return null;
  return deck.shift();
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

/**
 * Devuelve el símbolo Unicode del palo para mostrar en la interfaz.
 *
 * @param {string} suit - Nombre del palo
 * @returns {string} Símbolo Unicode
 */
function getSuitSymbol(suit) {
  const symbols = {
    hearts:   "♥",
    diamonds: "♦",
    clubs:    "♣",
    spades:   "♠",
    joker:    "★",
  };
  return symbols[suit] || "?";
}

/**
 * Devuelve la etiqueta legible de una carta para mostrar en la interfaz.
 * Ejemplos: "K♥", "7♠", "Q♣", "JOKER★"
 *
 * @param {Object} card - Objeto carta
 * @returns {string} Etiqueta de la carta
 */
function getCardLabel(card) {
  if (card.rank === "JOKER") {
    return `JOKER ${getSuitSymbol(card.suit)}`;
  }
  return `${card.rank}${getSuitSymbol(card.suit)}`;
}

// ─── Exportar ─────────────────────────────────────────────────────────────────
// Se usa como objeto global para compatibilidad con HTML/JS puro (sin bundler).
// En una futura versión con Node.js se cambiará a module.exports o export.

const Deck = {
  createDeck,
  shuffleDeck,
  drawCard,
  getCardValue,
  getCardLabel,
  getSuitSymbol,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Deck;
}
