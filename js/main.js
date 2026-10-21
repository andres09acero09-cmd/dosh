/**
 * main.js
 * Punto de entrada del juego DOS.
 *
 * Responsabilidades:
 *  - Inicializar la interfaz al cargar la página
 *  - Conectar los botones con la lógica de ui.js y game.js
 *  - Gestionar los controles de configuración (incrementar/decrementar)
 *
 * Depende de: deck.js, player.js, game.js, ui.js
 */

// ─── Límites de configuración ─────────────────────────────────────────────────

const CONFIG = {
  minPlayers: 2,
  maxPlayers: 8,
  minCards:   2,    // debe ser par; incrementos de 2
};

function getMaxCardsAllowed(players) {
  if (typeof Rules !== "undefined" && Rules.calculateMaxCards) {
    return Rules.calculateMaxCards(players);
  }
  return 10;
}

// ─── Contadores locales ───────────────────────────────────────────────────────
// Se usan solo para los controles +/−; el estado real vive en game.js

let currentPlayers = 2;
let currentCards   = 4;

function _adjustCardsToPlayerCount() {
  const maxAllowed = getMaxCardsAllowed(currentPlayers);
  if (currentCards > maxAllowed) {
    currentCards = maxAllowed;
    document.getElementById('val-cards').textContent = currentCards;
  }
}

// ─── Inicialización ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  UI.renderSetup();
  _attachListeners();
});

// ─── Listeners ────────────────────────────────────────────────────────────────

function _attachListeners() {

  // ── Configuración: número de jugadores ──
  document.getElementById('btn-less-players').addEventListener('click', () => {
    if (currentPlayers > CONFIG.minPlayers) {
      currentPlayers--;
      document.getElementById('val-players').textContent = currentPlayers;
      UI.updatePlayerNameInputs();
      _adjustCardsToPlayerCount();
    }
  });

  document.getElementById('btn-more-players').addEventListener('click', () => {
    if (currentPlayers < CONFIG.maxPlayers) {
      currentPlayers++;
      document.getElementById('val-players').textContent = currentPlayers;
      UI.updatePlayerNameInputs();
      _adjustCardsToPlayerCount();
    }
  });

  // ── Configuración: cartas por jugador (solo pares, saltos de 2) ──
  document.getElementById('btn-less-cards').addEventListener('click', () => {
    if (currentCards > CONFIG.minCards) {
      currentCards -= 2;
      document.getElementById('val-cards').textContent = currentCards;
    }
  });

  document.getElementById('btn-more-cards').addEventListener('click', () => {
    const maxAllowed = getMaxCardsAllowed(currentPlayers);
    if (currentCards < maxAllowed) {
      currentCards += 2;
      document.getElementById('val-cards').textContent = currentCards;
    }
  });

  // ── Botón iniciar partida ──
  document.getElementById('btn-start').addEventListener('click', () => {
    UI.clearSetupError();
    const { names, cardCount } = UI.getSetupValues();

    const result = Game.initGame(names, cardCount);
    if (!result.success) {
      UI.showSetupError(result.error);
      return;
    }

    // Todo ok → comenzar la fase de memoria
    UI.renderPeekScreen();
  });

  // ── Fase de memoria: botón "¡Estoy listo!" ──
  document.getElementById('btn-peek-ready').addEventListener('click', () => {
    UI.startPeekTimer();
  });

  // ── Fase de memoria: botón "Ya memoricé" (terminar antes de que acabe el tiempo) ──
  document.getElementById('btn-peek-done').addEventListener('click', () => {
    UI.endPeekTurn();
  });

  // ── Fase de memoria: botón "Siguiente" / "¡Comenzar!" ──
  document.getElementById('btn-peek-next').addEventListener('click', () => {
    if (Game.gameState.peekPhase.active) {
      // Todavía quedan jugadores por mirar
      UI.renderPeekScreen();
    } else {
      // Todos terminaron → ir a la mesa de juego
      UI.renderGameTable();
    }
  });

  // ── Mesa de juego: botón "Nueva partida" ──
  document.getElementById('btn-new-game').addEventListener('click', () => {
    // Volver a la pantalla de configuración
    UI.renderSetup();
  });
}
