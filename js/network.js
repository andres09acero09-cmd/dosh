// js/network.js - Cliente WebSocket para DOSH Online
//
// El cliente solo ENVÍA solicitudes de acción y RECIBE vistas filtradas del estado.
// Nunca envía ni recibe el estado completo de la partida (privacidad garantizar en el servidor).
const Network = (() => {
  let ws = null;
  let isConnected = false;
  let currentRoom = null;
  let myPlayerId = null;
  let isHost = false;
  const messageQueue = [];

  // Turno oficial conocido (vía STATE). Cada acción lo incluye para que el
  // servidor rechace acciones atrasadas o duplicadas.
  let lastTurnId = 0;

  // Callbacks de eventos
  const callbacks = {
    onConnected: null,
    onDisconnected: null,
    onRoomCreated: null,
    onRoomJoined: null,
    onRoomUpdate: null,
    onGameStart: null,
    onState: null,
    onPeekRevealed: null,
    onActionError: null,
    onBackToLobby: null,
    onPlayerLeft: null,
    onError: null,
  };

  function getWsUrl() {
    // Si estamos en localhost o servidor web, conectar al puerto 3000
    const host = window.location.hostname || 'localhost';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${host}:3000`;
  }

  function connect(customUrl) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const url = customUrl || getWsUrl();
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('Error conectando WebSocket:', e);
      if (callbacks.onError) callbacks.onError('No se pudo conectar al servidor multijugador.');
      return;
    }

    ws.onopen = () => {
      isConnected = true;
      console.log('🌐 Conectado al servidor DOSH Online');
      if (callbacks.onConnected) callbacks.onConnected();

      // Vaciar cola de mensajes pendientes que esperaban a que abriera la conexión
      while (messageQueue.length > 0) {
        const item = messageQueue.shift();
        ws.send(JSON.stringify(item));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        console.error('Error procesando mensaje del servidor:', e);
      }
    };

    ws.onclose = () => {
      isConnected = false;
      console.log('Desconectado del servidor DOSH Online');
      if (callbacks.onDisconnected) callbacks.onDisconnected();
    };

    ws.onerror = () => {
      if (callbacks.onError) {
        callbacks.onError('No se pudo conectar al servidor en el puerto 3000. Verifica que el servidor de Node esté activo ("node server.js").');
      }
    };
  }

  function handleServerMessage(msg) {
    const { type, payload } = msg;

    switch (type) {
      case 'ROOM_CREATED':
        currentRoom = payload;
        myPlayerId = payload.myId;
        isHost = true;
        lastTurnId = 0;
        if (callbacks.onRoomCreated) callbacks.onRoomCreated(payload);
        break;

      case 'ROOM_JOINED':
        currentRoom = payload;
        myPlayerId = payload.myId;
        isHost = payload.isHost;
        lastTurnId = 0;
        if (callbacks.onRoomJoined) callbacks.onRoomJoined(payload);
        break;

      case 'ROOM_UPDATE':
        if (currentRoom) {
          currentRoom.players = payload.players;
        }
        if (callbacks.onRoomUpdate) callbacks.onRoomUpdate(payload);
        break;

      case 'YOU_ARE_HOST':
        isHost = true;
        if (currentRoom && callbacks.onRoomUpdate) {
          callbacks.onRoomUpdate({ players: (currentRoom.players || []) });
        }
        break;

      case 'GAME_STARTED':
        lastTurnId = 0;
        if (callbacks.onGameStart) callbacks.onGameStart(payload);
        break;

      case 'STATE':
        if (payload && payload.public) {
          lastTurnId = payload.public.turnId ?? lastTurnId;
        }
        if (callbacks.onState) callbacks.onState(payload);
        break;

      case 'PEEK_REVEALED':
        // Se maneja junto al estado: callback dedicado
        if (callbacks.onPeekRevealed) callbacks.onPeekRevealed(payload);
        break;

      case 'ACTION_ERROR':
        if (callbacks.onActionError) callbacks.onActionError(payload.message);
        break;

      case 'ACTION_STALE':
        // Acción atrasada/duplicada: el servidor la ignoró; informar sin romper nada
        if (callbacks.onActionError) callbacks.onActionError(payload.message);
        break;

      case 'BACK_TO_LOBBY':
        if (currentRoom) {
          currentRoom.players = payload.players;
        }
        if (callbacks.onBackToLobby) callbacks.onBackToLobby(payload);
        break;

      case 'PLAYER_LEFT':
        if (currentRoom) {
          currentRoom.players = payload.players;
        }
        if (callbacks.onPlayerLeft) callbacks.onPlayerLeft(payload);
        break;

      case 'ERROR':
        if (callbacks.onError) callbacks.onError(payload.message);
        break;
    }
  }

  function send(type, payload) {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload }));
      return true;
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      console.log('WebSocket conectando... mensaje encolado:', type);
      messageQueue.push({ type, payload });
      return true;
    } else {
      console.warn('WebSocket no disponible.');
      if (callbacks.onError) {
        callbacks.onError('El servidor DOSH Online no responde en el puerto 3000. Inicia "node server.js" en la terminal.');
      }
      return false;
    }
  }

  function createRoom(name, targetPlayers, cardsPerPlayer) {
    send('CREATE_ROOM', { name, targetPlayers, cardsPerPlayer });
  }

  function joinRoom(roomCode, name) {
    send('JOIN_ROOM', { roomCode, name });
  }

  function startGame() {
    send('START_GAME', {});
  }

  /**
   * Envía una SOLICITUD de acción al servidor autoritativo.
   * El servidor valida autor, turno y legalidad.
   */
  function sendGameAction(action, data = {}, turnId = null) {
    const tid = (turnId === null) ? lastTurnId : turnId;
    send('GAME_ACTION', { action, ...data, turnId: tid });
  }

  function leaveRoom() {
    send('LEAVE_ROOM', {});
    currentRoom = null;
    isHost = false;
    lastTurnId = 0;
  }

  function on(event, callback) {
    if (event in callbacks) {
      callbacks[event] = callback;
    }
  }

  return {
    connect,
    createRoom,
    joinRoom,
    startGame,
    send: (type, payload) => send(type, payload),
    sendGameAction,
    leaveRoom,
    on,
    isConnected: () => isConnected,
    isHost: () => isHost,
    getCurrentRoom: () => currentRoom,
    getMyPlayerId: () => myPlayerId,
    getLastTurnId: () => lastTurnId,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Network;
}
