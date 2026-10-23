/**
 * main.js
 * Punto de entrada del juego DOSH.
 *
 * Responsabilidades:
 *  - Inicializar la interfaz y el selector de modo al cargar la página
 *  - Conectar los controles de partida Local y Multijugador Online
 *  - Conectar los eventos de red WebSocket (Network) con las vistas del Lobby y juego
 */

// ─── Límites de configuración ─────────────────────────────────────────────────

const CONFIG = {
  minPlayers: 2,
  maxPlayers: 8,
  minCards:   2,
  minOnlinePlayers: 3, // Mínimo 3 jugadores en modo Online
  maxOnlinePlayers: 8, // Máximo 8 jugadores en modo Online
};

function getMaxCardsAllowed(players) {
  if (typeof Rules !== "undefined" && Rules.calculateMaxCards) {
    return Rules.calculateMaxCards(players);
  }
  return 10;
}

// ─── Contadores locales ───────────────────────────────────────────────────────

let currentPlayers       = 2;
let currentCards         = 4;
let currentOnlinePlayers = 3;
let currentOnlineCards   = 4;

function _adjustCardsToPlayerCount() {
  const maxAllowed = getMaxCardsAllowed(currentPlayers);
  if (currentCards > maxAllowed) {
    currentCards = maxAllowed;
    document.getElementById('val-cards').textContent = currentCards;
  }
}

// ─── Inicialización ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  UI.renderModeSelect();
  _attachListeners();
  _setupNetworkListeners();
});

// ─── Listeners de Interfaz y Botones ──────────────────────────────────────────

function _attachListeners() {

  // ── 1. Selector de Modo ──
  const btnSelectOnline = document.getElementById('btn-select-online');
  if (btnSelectOnline) {
    btnSelectOnline.addEventListener('click', () => {
      UI.renderOnlineScreen();
      Network.connect();
    });
  }

  const btnSelectLocal = document.getElementById('btn-select-local');
  if (btnSelectLocal) {
    btnSelectLocal.addEventListener('click', () => {
      UI.renderSetup();
    });
  }

  const btnBackLocal = document.getElementById('btn-back-to-mode-local');
  if (btnBackLocal) {
    btnBackLocal.addEventListener('click', () => {
      UI.renderModeSelect();
    });
  }

  const btnBackOnline = document.getElementById('btn-back-to-mode-online');
  if (btnBackOnline) {
    btnBackOnline.addEventListener('click', () => {
      UI.renderModeSelect();
    });
  }

  // ── 2. Configuración Local: número de jugadores ──
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

  // ── Configuración Local: cartas por jugador ──
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

  // ── Botón iniciar partida Local ──
  document.getElementById('btn-start').addEventListener('click', () => {
    UI.clearSetupError();
    const { names, cardCount } = UI.getSetupValues();

    const result = Game.initGame(names, cardCount);
    if (!result.success) {
      UI.showSetupError(result.error);
      return;
    }

    UI.renderPeekScreen();
  });

  // ── 3. Multijugador Online: Tabs Crear / Unirse ──
  const tabBtnCreate = document.getElementById('tab-btn-create');
  const tabBtnJoin   = document.getElementById('tab-btn-join');
  const formCreate   = document.getElementById('form-create-room');
  const formJoin     = document.getElementById('form-join-room');

  if (tabBtnCreate && tabBtnJoin) {
    tabBtnCreate.addEventListener('click', () => {
      tabBtnCreate.classList.add('active');
      tabBtnJoin.classList.remove('active');
      formCreate.classList.remove('hidden');
      formJoin.classList.add('hidden');
    });

    tabBtnJoin.addEventListener('click', () => {
      tabBtnJoin.classList.add('active');
      tabBtnCreate.classList.remove('active');
      formJoin.classList.remove('hidden');
      formCreate.classList.add('hidden');
    });
  }

  // Controles de jugadores Online (mínimo 3, máximo 8)
  const btnLessOnlinePlayers = document.getElementById('btn-less-online-players');
  const btnMoreOnlinePlayers = document.getElementById('btn-more-online-players');
  if (btnLessOnlinePlayers && btnMoreOnlinePlayers) {
    btnLessOnlinePlayers.addEventListener('click', () => {
      if (currentOnlinePlayers > CONFIG.minOnlinePlayers) {
        currentOnlinePlayers--;
        document.getElementById('val-online-players').textContent = currentOnlinePlayers;
      }
    });

    btnMoreOnlinePlayers.addEventListener('click', () => {
      if (currentOnlinePlayers < CONFIG.maxOnlinePlayers) {
        currentOnlinePlayers++;
        document.getElementById('val-online-players').textContent = currentOnlinePlayers;
      }
    });
  }

  // Controles de cartas Online
  const btnLessOnlineCards = document.getElementById('btn-less-online-cards');
  const btnMoreOnlineCards = document.getElementById('btn-more-online-cards');
  if (btnLessOnlineCards && btnMoreOnlineCards) {
    btnLessOnlineCards.addEventListener('click', () => {
      if (currentOnlineCards > 4) {
        currentOnlineCards -= 2;
        document.getElementById('val-online-cards').textContent = currentOnlineCards;
      }
    });

    btnMoreOnlineCards.addEventListener('click', () => {
      if (currentOnlineCards < 8) {
        currentOnlineCards += 2;
        document.getElementById('val-online-cards').textContent = currentOnlineCards;
      }
    });
  }

  // Botón Crear Sala Online
  const btnCreateRoom = document.getElementById('btn-create-room');
  if (btnCreateRoom) {
    btnCreateRoom.addEventListener('click', () => {
      const name = document.getElementById('online-host-name').value.trim() || 'Jugador 1';
      Network.createRoom(name, currentOnlinePlayers, currentOnlineCards);
    });
  }

  // Botón Unirse a Sala Online
  const btnJoinRoom = document.getElementById('btn-join-room');
  if (btnJoinRoom) {
    btnJoinRoom.addEventListener('click', () => {
      const name = document.getElementById('online-join-name').value.trim() || 'Jugador 2';
      const code = document.getElementById('online-room-code').value.trim();
      const errEl = document.getElementById('online-join-error');

      if (!code) {
        errEl.textContent = 'Por favor ingresa un código de sala.';
        errEl.classList.remove('hidden');
        return;
      }
      errEl.classList.add('hidden');
      Network.joinRoom(code, name);
    });
  }

  // Botón Copiar Código
  const btnCopyCode = document.getElementById('btn-copy-code');
  if (btnCopyCode) {
    btnCopyCode.addEventListener('click', () => {
      const code = document.getElementById('lobby-room-code').textContent;
      if (code && navigator.clipboard) {
        navigator.clipboard.writeText(code).then(() => {
          Anim.toast(`Código ${code} copiado al portapapeles`, 'info', 1800);
        });
      }
    });
  }

  // Botón Iniciar Partida Online (Host)
  const btnStartOnlineGame = document.getElementById('btn-start-online-game');
  if (btnStartOnlineGame) {
    btnStartOnlineGame.addEventListener('click', () => {
      Network.startGame();
    });
  }

  // Botón Salir de la Sala
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  if (btnLeaveRoom) {
    btnLeaveRoom.addEventListener('click', () => {
      Network.leaveRoom();
      _showOnlineEntryPanel();
    });
  }

  // ── 4. Fase de memoria ──
  document.getElementById('btn-peek-ready').addEventListener('click', () => {
    if (Game.gameState.isOnline) {
      UI.startOnlinePeekTimer();
    } else {
      UI.startPeekTimer();
    }
  });

  document.getElementById('btn-peek-done').addEventListener('click', () => {
    if (Game.gameState.isOnline) {
      UI.endOnlinePeekTurn();
    } else {
      UI.endPeekTurn();
    }
  });

  document.getElementById('btn-peek-next').addEventListener('click', () => {
    if (Game.gameState.peekPhase.active) {
      UI.renderPeekScreen();
    } else {
      UI.renderGameTable();
    }
  });

  // ── 5. Mesa de juego: botón "Nueva partida" ──
  document.getElementById('btn-new-game').addEventListener('click', () => {
    UI.renderModeSelect();
  });
}

// ─── Conexión con Eventos del Servidor (Network) ──────────────────────────────

function _setupNetworkListeners() {
  Network.on('onRoomCreated', (data) => {
    _showLobbyPanel(data);
  });

  Network.on('onRoomJoined', (data) => {
    _showLobbyPanel(data);
  });

  Network.on('onRoomUpdate', (data) => {
    _updateLobbyPlayersList(data.players);
  });

  Network.on('onGameStart', (data) => {
    // El SERVIDOR baraja y reparte: aquí solo preparamos la vista local (cartas ocultas)
    UI.startOnlineGame(data.players, data.cardsPerPlayer);
  });

  // El SERVIDOR es la única autoridad: llega el estado filtrado (público + privado)
  Network.on('onState', (payload) => {
    UI.applyServerState(payload);
  });

  // El servidor respondió SOLO a este cliente con la identidad de una carta vista durante el peek
  Network.on('onPeekRevealed', (payload) => {
    UI.applyPeekReveal(payload);
  });

  // El servidor rechazó una acción (fuera de turno, ilegal o atrasada)
  Network.on('onActionError', (message) => {
    Anim.toast(message, 'error', 2200);
  });

  // El anfitrión mandó a todos de vuelta al lobby
  Network.on('onBackToLobby', () => {
    if (typeof UI.stopTurnTimer === 'function') UI.stopTurnTimer();
    showScreen('screen-mode');
    if (typeof UI.renderOnlineScreen === 'function') {
      UI.renderOnlineScreen();
      _showOnlineEntryPanel();
    }
  });

  Network.on('onError', (message) => {
    const createErr = document.getElementById('online-create-error');
    const joinErr   = document.getElementById('online-join-error');
    if (createErr && !createErr.parentElement.classList.contains('hidden')) {
      createErr.textContent = message;
      createErr.classList.remove('hidden');
    } else if (joinErr) {
      joinErr.textContent = message;
      joinErr.classList.remove('hidden');
    } else {
      Anim.toast(message, 'error', 3000);
    }
  });
}

function _showLobbyPanel(roomData) {
  const panelEntry = document.getElementById('online-panel-entry');
  const panelLobby = document.getElementById('online-panel-lobby');
  if (panelEntry && panelLobby) {
    panelEntry.classList.add('hidden');
    panelLobby.classList.remove('hidden');
  }

  document.getElementById('lobby-room-code').textContent = roomData.roomCode;
  _updateLobbyPlayersList(roomData.players);

  const btnStart = document.getElementById('btn-start-online-game');
  if (btnStart) {
    if (Network.isHost()) {
      btnStart.classList.remove('hidden');
      btnStart.disabled = false;
      btnStart.textContent = 'INICIAR PARTIDA';
    } else {
      btnStart.classList.remove('hidden');
      btnStart.disabled = true;
      btnStart.textContent = 'ESPERANDO AL ANFITRIÓN...';
    }
  }
}

function _showOnlineEntryPanel() {
  const panelEntry = document.getElementById('online-panel-entry');
  const panelLobby = document.getElementById('online-panel-lobby');
  if (panelEntry && panelLobby) {
    panelEntry.classList.remove('hidden');
    panelLobby.classList.add('hidden');
  }
}

function _updateLobbyPlayersList(players) {
  const listEl  = document.getElementById('lobby-players-list');
  const countEl = document.getElementById('lobby-players-count');
  const room    = Network.getCurrentRoom();
  const target  = room ? room.targetPlayers : 3;

  if (!listEl) return;
  listEl.innerHTML = '';

  const humanCount = players.filter(p => !p.isBot).length;
  if (countEl) {
    countEl.textContent = `Jugadores: ${humanCount} / ${target}`;
  }

  players.forEach((p, idx) => {
    const item = document.createElement('div');
    item.className = 'lobby-player-item';

    const isMe = p.id === Network.getMyPlayerId();
    const isHost = idx === 0;

    let tagHtml = '';
    if (isHost) tagHtml += `<span class="player-tag host">👑 Host</span> `;
    if (isMe)   tagHtml += `<span class="player-tag you">Tú</span> `;
    if (p.isBot) tagHtml += `<span class="player-tag bot">🤖 Bot</span> `;

    item.innerHTML = `
      <div style="font-weight: 700;">${p.name}</div>
      <div>${tagHtml}</div>
    `;
    listEl.appendChild(item);
  });
}
