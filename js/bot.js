// js/bot.js - Motor de Inteligencia Artificial para Bots de DOSH
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.BotAI = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // Memoria individual por bot: Map<playerIndex, { knownSlots: Map<slotIndex, card> }>
  const botMemories = new Map();

  function initBotMemory(playerIndex) {
    botMemories.set(playerIndex, {
      knownSlots: new Map(), // slotIndex -> cardData
      knownRivals: new Map(), // 'pIndex_sIndex' -> cardData
    });
  }

  function getBotMemory(playerIndex) {
    if (!botMemories.has(playerIndex)) {
      initBotMemory(playerIndex);
    }
    return botMemories.get(playerIndex);
  }

  function recordCardInMemory(playerIndex, slotIndex, card) {
    const mem = getBotMemory(playerIndex);
    if (card) {
      mem.knownSlots.set(slotIndex, { rank: card.rank, suit: card.suit, color: card.color });
    }
  }

  function removeSlotFromMemory(playerIndex, slotIndex, newHandLength) {
    const mem = getBotMemory(playerIndex);
    mem.knownSlots.delete(slotIndex);
    // Reindexar memoria si cambió el tamaño del array
    const updated = new Map();
    mem.knownSlots.forEach((card, idx) => {
      if (idx < slotIndex) updated.set(idx, card);
      else if (idx > slotIndex) updated.set(idx - 1, card);
    });
    mem.knownSlots = updated;
  }

  function getCardPoints(card) {
    if (!card) return 7;
    if (card.rank === 'JOKER') return 15;
    if (card.rank === 'K') return card.color === 'red' ? 0 : 13;
    if (card.rank === 'Q') return 12;
    if (card.rank === 'J') return 11;
    if (card.rank === 'A') return 1;
    const n = parseInt(card.rank, 10);
    return isNaN(n) ? 7 : n;
  }

  /**
   * Ejecuta el turno del Bot de manera autónoma con retrasos realistas.
   *
   * @param {number} botIndex - Índice del bot activo
   * @param {Object} gameState - Estado actual del juego
   * @param {Object} actions - Callbacks para ejecutar acciones en la UI / Game
   */
  async function playTurn(botIndex, gameState, actions) {
    const player = gameState.players[botIndex];
    if (!player) return;

    const mem = getBotMemory(botIndex);

    // Pequeño delay de pensamiento inicial (1.2s - 1.8s)
    await sleep(1200 + Math.random() * 600);

    // ── 1. Evaluar si cantar ¡DOSH! ──
    if (gameState.doshAnnouncedBy === null && !gameState.drawnCard && !gameState.qChainActive) {
      let knownSum = 0;
      let knownCount = 0;
      player.hand.forEach((slot, sIdx) => {
        const c = mem.knownSlots.get(sIdx) || (slot && slot.known ? slot.card : null);
        if (c) {
          knownSum += getCardPoints(c);
          knownCount++;
        }
      });

      // Si conoce la mayoría de sus cartas y suman 7 o menos, o tiene 1 sola carta baja
      if ((knownCount >= player.hand.length - 1 && knownSum <= 8) || (player.hand.length === 1 && knownSum <= 4)) {
        if (actions.announceDosh) {
          actions.announceDosh();
          await sleep(1000);
        }
      }
    }

    // ── 2. Evaluar Cadena de Q activa ──
    if (gameState.qChainActive && gameState.activeTableCard && gameState.activeTableCard.rank === 'Q' && gameState.currentPlayerIndex !== gameState.qOriginPlayerIndex) {
      // El bot siempre aprovecha para ver una carta desconocida
      let targetSlot = -1;
      for (let i = 0; i < player.hand.length; i++) {
        if (!mem.knownSlots.has(i)) {
          targetSlot = i;
          break;
        }
      }
      if (targetSlot === -1) targetSlot = 0; // Si ya conoce todas, mira la primera

      if (actions.useQPeek) {
        await actions.useQPeek(targetSlot);
        const viewedCard = player.hand[targetSlot] ? player.hand[targetSlot].card : null;
        if (viewedCard) recordCardInMemory(botIndex, targetSlot, viewedCard);
      }
      return;
    }

    // ── 3. Evaluar Carta en Mesa (si no ha robado aún) ──
    if (!gameState.drawnCard && gameState.activeTableCard) {
      const tableCard = gameState.activeTableCard;
      const isJoker = tableCard.rank === 'JOKER';

      // ¿Puede hacer copia con una carta conocida?
      let matchingSlot = -1;
      player.hand.forEach((slot, sIdx) => {
        const c = mem.knownSlots.get(sIdx) || (slot && slot.known ? slot.card : null);
        if (c && c.rank === tableCard.rank) {
          matchingSlot = sIdx;
        }
      });

      if (matchingSlot !== -1 && actions.matchWithTable) {
        await actions.matchWithTable(matchingSlot);
        return;
      }

      // ¿Le conviene cambiar la carta de la mesa (si no es Joker)?
      if (!isJoker && actions.replaceWithTable) {
        const tableValue = getCardPoints(tableCard);
        let worstSlot = -1;
        let worstValue = tableValue;

        player.hand.forEach((slot, sIdx) => {
          const c = mem.knownSlots.get(sIdx) || (slot && slot.known ? slot.card : null);
          if (c) {
            const v = getCardPoints(c);
            if (v > worstValue) {
              worstValue = v;
              worstSlot = sIdx;
            }
          }
        });

        // Si la de la mesa es muy buena (ej: As=1, K roja=0, o <= 3) y el bot tiene una carta peor (>= 7)
        if (worstSlot !== -1 && tableValue <= 3 && worstValue >= 7) {
          await actions.replaceWithTable(worstSlot);
          recordCardInMemory(botIndex, worstSlot, tableCard);
          return;
        }
      }
    }

    // ── 4. Si no tomó la de la mesa, voltea del mazo ──
    if (!gameState.drawnCard && actions.drawFromDeck) {
      await actions.drawFromDeck();
      await sleep(1400);
    }

    // Si tras voltear la carta ya se avanzó turno (por ejemplo penalización u otro)
    if (!gameState.drawnCard && !gameState.pendingDiscardPower) return;

    // ── 5. Procesar Carta Volteada o Poder Pendiente ──
    const activeCard = gameState.drawnCard || (gameState.pendingDiscardPower ? gameState.pendingDiscardPower.card : null);

    // CASO JOKER ROJO (Obligatorio botar carta)
    const isJokerRed = (gameState.drawnCard && gameState.drawnCard.rank === 'JOKER' && gameState.drawnCard.color === 'red')
      || (gameState.pendingDiscardPower && gameState.pendingDiscardPower.type === 'JOKER_RED');

    if (isJokerRed && actions.useJokerRed) {
      // Elige botar su carta conocida de mayor valor, o la primera
      let highestSlot = 0;
      let highestVal = -1;
      player.hand.forEach((slot, sIdx) => {
        const c = mem.knownSlots.get(sIdx) || (slot && slot.known ? slot.card : null);
        const val = c ? getCardPoints(c) : 7;
        if (val > highestVal) {
          highestVal = val;
          highestSlot = sIdx;
        }
      });

      await sleep(800);
      await actions.useJokerRed(highestSlot);
      removeSlotFromMemory(botIndex, highestSlot, player.hand.length);
      return;
    }

    // CASO JOKER NEGRO (Obligatorio castigar rival)
    const isJokerBlack = (gameState.drawnCard && gameState.drawnCard.rank === 'JOKER' && gameState.drawnCard.color === 'black')
      || (gameState.pendingDiscardPower && gameState.pendingDiscardPower.type === 'JOKER_BLACK');

    if (isJokerBlack && actions.useJokerBlack) {
      // Castigar al humano o al jugador con menos cartas
      let targetRival = (botIndex + 1) % gameState.players.length;
      let minCards = 999;
      gameState.players.forEach((p, idx) => {
        if (idx !== botIndex) {
          if (!p.isBot) {
            targetRival = idx; // Priorizar humanos
          } else if (p.hand.length < minCards) {
            minCards = p.hand.length;
            targetRival = idx;
          }
        }
      });

      await sleep(800);
      await actions.useJokerBlack(targetRival);
      return;
    }

    // CASO Q (Ver carta propia)
    const isQ = (gameState.drawnCard && gameState.drawnCard.rank === 'Q')
      || (gameState.pendingDiscardPower && gameState.pendingDiscardPower.type === 'Q');

    if (isQ && actions.useQPeek) {
      let targetSlot = 0;
      for (let i = 0; i < player.hand.length; i++) {
        if (!mem.knownSlots.has(i)) {
          targetSlot = i;
          break;
        }
      }

      await sleep(600);
      await actions.useQPeek(targetSlot);
      const c = player.hand[targetSlot] ? player.hand[targetSlot].card : null;
      if (c) recordCardInMemory(botIndex, targetSlot, c);
      return;
    }

    // CASO J (Intercambiar carta)
    const isJ = (gameState.drawnCard && gameState.drawnCard.rank === 'J' && gameState.jPowerUsable)
      || (gameState.pendingDiscardPower && gameState.pendingDiscardPower.type === 'J');

    if (isJ && actions.useJSwap) {
      // Elegir la peor carta propia
      let myWorstSlot = 0;
      let myWorstVal = -1;
      player.hand.forEach((slot, sIdx) => {
        const c = mem.knownSlots.get(sIdx) || (slot && slot.known ? slot.card : null);
        const v = c ? getCardPoints(c) : 8;
        if (v > myWorstVal) {
          myWorstVal = v;
          myWorstSlot = sIdx;
        }
      });

      // Elegir un rival objetivo
      let rivalIndex = (botIndex + 1) % gameState.players.length;
      let rivalSlot = 0;
      if (actions.useJSwap) {
        await sleep(600);
        await actions.useJSwap(myWorstSlot, rivalIndex, rivalSlot);
        mem.knownSlots.delete(myWorstSlot); // Ya no conoce su nueva carta
        return;
      }
    }

    // CASO CARTA NORMAL VOLTEADA DEL MAZO
    if (gameState.drawnCard) {
      const drawn = gameState.drawnCard;
      const drawnVal = getCardPoints(drawn);

      // ¿Puede hacer copia con una carta de su mano?
      let matchSlot = -1;
      player.hand.forEach((slot, sIdx) => {
        const c = mem.knownSlots.get(sIdx) || (slot && slot.known ? slot.card : null);
        if (c && c.rank === drawn.rank) {
          matchSlot = sIdx;
        }
      });

      if (matchSlot !== -1 && actions.matchWithDrawn) {
        await sleep(600);
        await actions.matchWithDrawn(matchSlot);
        removeSlotFromMemory(botIndex, matchSlot, player.hand.length);
        return;
      }

      // ¿Le conviene cambiar la carta por una de su mano?
      let replaceSlot = -1;
      let worstVal = drawnVal;

      player.hand.forEach((slot, sIdx) => {
        const c = mem.knownSlots.get(sIdx) || (slot && slot.known ? slot.card : null);
        if (c) {
          const v = getCardPoints(c);
          if (v > worstVal) {
            worstVal = v;
            replaceSlot = sIdx;
          }
        }
      });

      // Si la robada es mejor que la peor conocida, o si no conoce casi nada y sacó As/K roja/2/3/4
      if (replaceSlot !== -1 && worstVal - drawnVal >= 3) {
        await sleep(600);
        await actions.replaceWithDrawn(replaceSlot);
        recordCardInMemory(botIndex, replaceSlot, drawn);
        return;
      }

      if (drawnVal <= 3) {
        // Carta muy buena, cambiar por una desconocida
        for (let i = 0; i < player.hand.length; i++) {
          if (!mem.knownSlots.has(i)) {
            replaceSlot = i;
            break;
          }
        }
        if (replaceSlot !== -1 && actions.replaceWithDrawn) {
          await sleep(600);
          await actions.replaceWithDrawn(replaceSlot);
          recordCardInMemory(botIndex, replaceSlot, drawn);
          return;
        }
      }

      // Si no le sirve, la deja en la mesa
      if (actions.discardDrawn) {
        await sleep(500);
        await actions.discardDrawn();
      }
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    initBotMemory,
    getBotMemory,
    recordCardInMemory,
    removeSlotFromMemory,
    playTurn
  };
});
