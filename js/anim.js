/**
 * anim.js — Motor de animaciones del juego DOS
 *
 * Usa la Web Animations API (element.animate()) para control preciso de
 * trayectorias, timing y efectos. Todas las funciones devuelven Promise.
 *
 * API pública (objeto Anim):
 *   shuffleIntro()                    → Promise  overlay de barajeo antes de iniciar
 *   drawFromDeck(cardData)            → Promise  carta vuela del mazo boca abajo → voltea boca arriba
 *   flyCardToTable(slotEl, cardData)  → Promise  carta de la mano vuela a la pila central
 *   copySuccess(slotEl)               → Promise  carta sube, brilla en verde, desaparece
 *   copyFail(slotEl)                  → Promise  carta se sacude, queda revelada, parpadea rojo
 *   penaltyFly(playerAreaEl)          → Promise  carta roja del mazo vuela a la mano
 *   toast(msg, type, ms)              → Promise  mensaje flotante animado
 *   deckGlow()                        → void     destello dorado en el mazo
 *   tableLand()                       → void     rebote en la carta en mesa
 *   playerAreaBounce(playerAreaEl)    → void     rebote del área del jugador activo
 */

'use strict';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const _w  = () => document.getElementById('card-width-ref')?.offsetWidth
                 || parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 58;
const _h  = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-h')) || 87;

/** Bounding rect de un elemento en coordenadas viewport */
function _r(el) { return el.getBoundingClientRect(); }

/** Esperar N ms */
const _wait = ms => new Promise(r => setTimeout(r, ms));

/** Anima un elemento con la Web Animations API y devuelve Promise cuando termina */
function _anim(el, keyframes, opts) {
  return el.animate(keyframes, { fill: 'forwards', ...opts }).finished;
}

/**
 * Construye un div que representa una carta volante posicionada en `rect`.
 * Si cardData se proporciona, se muestra boca arriba con rank+suit.
 */
function _makeFlyingCard(rect, cardData = null) {
  const SUIT = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠', joker: '★' };
  const el = document.createElement('div');

  if (cardData) {
    const sym = SUIT[cardData.suit] || '?';
    el.className = `flying-card face-up ${cardData.color || 'black'}`;
    el.innerHTML = `
      <span style="display:block;line-height:1;font-size:0.78rem">${cardData.rank}${sym}</span>
      <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:1.4rem;line-height:1">${sym}</span>
      <span style="display:block;line-height:1;font-size:0.78rem;transform:rotate(180deg);align-self:flex-end">${cardData.rank}${sym}</span>
    `;
  } else {
    el.className = 'flying-card face-down';
  }

  Object.assign(el.style, {
    left:   rect.left + 'px',
    top:    rect.top  + 'px',
    width:  rect.width  + 'px',
    height: rect.height + 'px',
  });

  document.body.appendChild(el);
  return el;
}

/**
 * Vuela una carta (div .flying-card) desde su posición actual hasta `toRect`.
 * Aplica una curva de arco (punto intermedio elevado) para que parezca real.
 *
 * @param {HTMLElement} flyEl   - El div .flying-card a mover
 * @param {DOMRect}     toRect  - Posición destino
 * @param {number}      ms      - Duración en ms
 * @param {object}      opts    - Opciones extra: { arcHeight, startScale, endScale, endRotate, easing }
 */
async function _fly(flyEl, toRect, ms = 380, opts = {}) {
  const {
    arcHeight  = -60,
    startScale = 1.0,
    endScale   = 1.0,
    endRotate  = 0,
    easing     = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  } = opts;

  const from = _r(flyEl);
  const dx = toRect.left - from.left;
  const dy = toRect.top  - from.top;

  // Calculamos el arco como translateX/Y en keyframes
  const midX = dx / 2;
  const midY = dy / 2 + arcHeight;

  await _anim(flyEl, [
    { transform: `translate(0px, 0px) scale(${startScale}) rotate(0deg)`, offset: 0 },
    { transform: `translate(${midX}px, ${midY}px) scale(${Math.max(startScale, endScale) * 1.08}) rotate(${endRotate * 0.5}deg)`, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(${endScale}) rotate(${endRotate}deg)`, offset: 1 },
  ], { duration: ms, easing, fill: 'forwards' });
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let _toastEl = null;

async function toast(msg, type = 'info', durationMs = 1800) {
  // Remover toast anterior si existe
  if (_toastEl) { _toastEl.remove(); _toastEl = null; }

  const div = document.createElement('div');
  div.className = `anim-toast ${type}`;
  div.textContent = msg;
  document.body.appendChild(div);
  _toastEl = div;

  // Entrada: baja desde arriba con rebote
  await _anim(div, [
    { transform: 'translateX(-50%) translateY(-70px) scale(0.8)', opacity: 0 },
    { transform: 'translateX(-50%) translateY(8px) scale(1.05)',  opacity: 1, offset: 0.65 },
    { transform: 'translateX(-50%) translateY(0px) scale(1)',     opacity: 1 },
  ], { duration: 380, easing: 'cubic-bezier(0.22, 1.1, 0.36, 1)' });

  await _wait(durationMs);

  // Salida: sube y desvanece
  await _anim(div, [
    { transform: 'translateX(-50%) translateY(0) scale(1)',       opacity: 1 },
    { transform: 'translateX(-50%) translateY(-30px) scale(0.9)', opacity: 0 },
  ], { duration: 280, easing: 'ease-in' });

  div.remove();
  if (_toastEl === div) _toastEl = null;
}

// ─── Barajar en la mesa directamente sobre el mazo ────────────────────────────

/**
 * Anima el barajado de cartas directamente sobre el elemento #deck-pile en la mesa de juego.
 * Hace que varias cartas se separen en dos montones hacia los lados y se intercalen (riffle shuffle).
 */
async function shuffleDeckOnTable() {
  const deckEl = document.getElementById('deck-pile');
  if (!deckEl) return;

  const rect = _r(deckEl);
  if (rect.width === 0 || rect.height === 0) return;

  // Crear cartas temporales superpuestas en el mazo
  const count = 6;
  const cards = [];
  for (let i = 0; i < count; i++) {
    const c = document.createElement('div');
    c.className = 'flying-card face-down';
    c.style.left = rect.left + 'px';
    c.style.top = rect.top + 'px';
    c.style.width = rect.width + 'px';
    c.style.height = rect.height + 'px';
    c.style.zIndex = (9990 + i).toString();
    c.style.boxShadow = '0 3px 8px rgba(0,0,0,0.4)';
    document.body.appendChild(c);
    cards.push(c);
  }

  // Pequeña pausa
  await _wait(30);

  // 1. Separar en dos montones: izquierda y derecha
  const splitPromises = cards.map((c, i) => {
    const isLeft = i % 2 === 0;
    const offsetX = isLeft ? -28 - (i * 2) : 28 + (i * 2);
    const offsetY = -4 - (i * 1.5);
    const rot = isLeft ? -14 : 14;

    return _anim(c, [
      { transform: 'translate(0px, 0px) rotate(0deg) scale(1)' },
      { transform: `translate(${offsetX}px, ${offsetY}px) rotate(${rot}deg) scale(1.05)` }
    ], { duration: 250, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
  });
  await Promise.all(splitPromises);

  // 2. Breve oscilación/rifle
  const rifflePromises = cards.map((c, i) => {
    const isLeft = i % 2 === 0;
    const baseOffsetX = isLeft ? -28 : 28;
    const rot = isLeft ? -14 : 14;
    return _anim(c, [
      { transform: `translate(${baseOffsetX}px, -4px) rotate(${rot}deg) scale(1.05)` },
      { transform: `translate(${baseOffsetX * 0.8}px, -8px) rotate(${rot * 0.7}deg) scale(1.08)`, offset: 0.5 },
      { transform: `translate(${baseOffsetX}px, -4px) rotate(${rot}deg) scale(1.05)` }
    ], { duration: 180, delay: i * 25, easing: 'ease-in-out' });
  });
  await Promise.all(rifflePromises);

  // 3. Volver a juntar las cartas en cascada al centro
  const mergePromises = cards.map((c, i) => {
    const isLeft = i % 2 === 0;
    const baseOffsetX = isLeft ? -28 : 28;
    const rot = isLeft ? -14 : 14;
    return _anim(c, [
      { transform: `translate(${baseOffsetX}px, -4px) rotate(${rot}deg) scale(1.05)` },
      { transform: 'translate(0px, 0px) rotate(0deg) scale(1)' }
    ], { duration: 220, delay: i * 35, easing: 'cubic-bezier(0.25, 0.9, 0.3, 1)' });
  });
  await Promise.all(mergePromises);

  // 4. Pequeño golpe/acomodación del mazo
  deckGlow();
  cards.forEach(c => c.remove());
}

// ─── Voltear carta del mazo ───────────────────────────────────────────────────

/**
 * Una carta sale del mazo boca abajo, vuela al centro y se voltea mostrando su cara.
 * @param {Object} cardData - { rank, suit, color } de la carta que salió
 */
async function drawFromDeck(cardData) {
  const deckEl  = document.getElementById('deck-pile');
  const tableEl = document.getElementById('drawn-card-slot');
  if (!deckEl || !tableEl) return;

  // Destello en el mazo
  deckGlow();

  const fromRect = _r(deckEl);
  const toRect   = _r(tableEl);

  // Carta fantasma boca abajo
  const fly = _makeFlyingCard(fromRect, null);

  // 1. Levantar del mazo con escala
  await _anim(fly, [
    { transform: 'scale(1) rotate(0deg)',    boxShadow: '0 4px 8px rgba(0,0,0,0.4)' },
    { transform: 'scale(1.12) rotate(-3deg)', boxShadow: '0 16px 32px rgba(0,0,0,0.55)' },
  ], { duration: 140, easing: 'ease-out' });

  // 2. Volar hasta el destino con arco y FLIP a mitad de vuelo
  const dx = toRect.left - fromRect.left;
  const dy = toRect.top  - fromRect.top;
  const midX = dx / 2;
  const midY = dy / 2 - 55;

  // Fase A: primera mitad del vuelo (boca abajo → aplanada en el medio)
  await _anim(fly, [
    { transform: `translate(0px, 0px) scale(1.12) rotateY(0deg)` },
    { transform: `translate(${midX}px, ${midY}px) scale(1.15) rotateY(90deg)` },
  ], { duration: 200, easing: 'ease-in' });

  // Cambiar a cara visible en el punto más alto
  if (cardData) {
    const SUIT = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠', joker: '★' };
    const sym = SUIT[cardData.suit] || '?';
    fly.className = `flying-card face-up ${cardData.color || 'black'}`;
    fly.innerHTML = `
      <span style="display:block;line-height:1;font-size:0.78rem">${cardData.rank}${sym}</span>
      <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:1.4rem;line-height:1">${sym}</span>
      <span style="display:block;line-height:1;font-size:0.78rem;transform:rotate(180deg);align-self:flex-end">${cardData.rank}${sym}</span>
    `;
  }

  // Fase B: segunda mitad del vuelo (cara visible → aterriza)
  await _anim(fly, [
    { transform: `translate(${midX}px, ${midY}px) scale(1.15) rotateY(-90deg)` },
    { transform: `translate(${dx}px, ${dy}px) scale(1) rotateY(0deg)` },
  ], { duration: 200, easing: 'ease-out' });

  // 3. Pequeño rebote al aterrizar
  await _anim(fly, [
    { transform: `translate(${dx}px, ${dy}px) scale(1)` },
    { transform: `translate(${dx}px, ${dy - 8}px) scale(1.06)` },
    { transform: `translate(${dx}px, ${dy}px) scale(1)` },
  ], { duration: 180, easing: 'ease-out' });

  fly.remove();

  // Rebote en la carta en mesa
  tableLand();
}

// ─── Carta de mano vuela a la pila de mesa ───────────────────────────────────

/**
 * La carta del slot elegido vuela hasta la pila de mesa con arco visible.
 * @param {HTMLElement} slotEl   - El div .card de la mano
 * @param {Object}      cardData - Datos de la carta (para mostrarla boca arriba durante el vuelo)
 */
async function flyCardToTable(slotEl, cardData = null) {
  if (!slotEl) return;
  const tableEl = document.getElementById('drawn-card-slot');
  if (!tableEl) return;

  const fromRect = _r(slotEl);
  const toRect   = _r(tableEl);

  const fly = _makeFlyingCard(fromRect, cardData);

  // Levantar
  await _anim(fly, [
    { transform: 'scale(1)',    boxShadow: '0 4px 8px rgba(0,0,0,0.35)' },
    { transform: 'scale(1.15)', boxShadow: '0 20px 40px rgba(0,0,0,0.55)' },
  ], { duration: 120, easing: 'ease-out' });

  // Volar con arco suave
  await _fly(fly, toRect, 340, { arcHeight: -50, startScale: 1.15, endScale: 1.0, easing: 'cubic-bezier(0.3,0,0.2,1)' });

  // Rebote de aterrizaje
  const dx = toRect.left - fromRect.left;
  const dy = toRect.top  - fromRect.top;
  await _anim(fly, [
    { transform: `translate(${dx}px, ${dy}px) scale(1) rotate(0deg)` },
    { transform: `translate(${dx}px, ${dy - 10}px) scale(1.08) rotate(-2deg)` },
    { transform: `translate(${dx}px, ${dy}px) scale(1) rotate(0deg)` },
  ], { duration: 200, easing: 'ease-out' });

  fly.remove();
  tableLand();
}

// ─── Copia correcta ───────────────────────────────────────────────────────────

/**
 * La carta elegida sube, gira, brilla verde y se encoge hasta desaparecer.
 * @param {HTMLElement} slotEl   - El div .card de la mano
 * @param {Object}      cardData - Datos de la carta
 */
async function copySuccess(slotEl, cardData = null) {
  if (!slotEl) return;
  const fromRect = _r(slotEl);
  const fly = _makeFlyingCard(fromRect, cardData);

  // Subir y brillar verde
  await _anim(fly, [
    {
      transform: 'scale(1) translateY(0px) rotate(0deg)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      filter: 'brightness(1)',
    },
    {
      transform: 'scale(1.25) translateY(-40px) rotate(8deg)',
      boxShadow: '0 0 0 5px #69db7c, 0 16px 40px rgba(105,219,124,0.7)',
      filter: 'brightness(1.2)',
      offset: 0.45,
    },
    {
      transform: 'scale(0) translateY(-80px) rotate(20deg)',
      boxShadow: '0 0 0 2px #69db7c',
      opacity: 0,
      filter: 'brightness(1.5)',
    },
  ], { duration: 520, easing: 'cubic-bezier(0.4, 0, 0.8, 0.6)' });

  fly.remove();

  // Pulso verde en la carta en mesa
  const tableEl = document.getElementById('drawn-card-slot');
  if (tableEl) {
    const topCard = tableEl.querySelector('.top-card') || tableEl;
    topCard.classList.remove('pulse-ok');
    void topCard.offsetWidth; // reflow para reiniciar animación
    topCard.classList.add('pulse-ok');
    setTimeout(() => topCard.classList.remove('pulse-ok'), 600);
  }
}

// ─── Copia incorrecta ─────────────────────────────────────────────────────────

/**
 * La carta elegida se saca, se revela (se voltea), se sacude con rojo y vuelve a su lugar.
 * @param {HTMLElement} slotEl   - El div .card de la mano
 * @param {Object}      cardData - Datos de la carta (para mostrarla boca arriba)
 */
async function copyFail(slotEl, cardData = null) {
  if (!slotEl) return;
  const fromRect = _r(slotEl);

  // Crear la carta mostrando su cara (revelación)
  const fly = _makeFlyingCard(fromRect, cardData);

  // 1. Levantar carta
  await _anim(fly, [
    { transform: 'scale(1) translateY(0px)',    boxShadow: '0 4px 8px rgba(0,0,0,0.4)' },
    { transform: 'scale(1.18) translateY(-20px)', boxShadow: '0 16px 32px rgba(0,0,0,0.5)' },
  ], { duration: 160, easing: 'ease-out' });

  // 2. Flip para revelar (rotateY)
  await _anim(fly, [
    { transform: 'scale(1.18) translateY(-20px) rotateY(0deg)' },
    { transform: 'scale(1.18) translateY(-20px) rotateY(90deg)' },
  ], { duration: 140, easing: 'ease-in' });

  // Si no teníamos cara, ponerla ahora (en el punto medio)
  // (ya debería estar con cara si cardData se pasó)

  await _anim(fly, [
    { transform: 'scale(1.18) translateY(-20px) rotateY(-90deg)' },
    { transform: 'scale(1.18) translateY(-20px) rotateY(0deg)' },
  ], { duration: 140, easing: 'ease-out' });

  // 3. Sacudir con rojo
  await _anim(fly, [
    { transform: 'scale(1.18) translateY(-20px) translateX(0)',   boxShadow: '0 16px 32px rgba(0,0,0,0.5)' },
    { transform: 'scale(1.18) translateY(-20px) translateX(-14px)', boxShadow: '0 0 0 4px #ff6b6b, 0 16px 32px rgba(255,80,80,0.5)', offset: 0.15 },
    { transform: 'scale(1.18) translateY(-20px) translateX(14px)',  boxShadow: '0 0 0 4px #ff6b6b, 0 16px 32px rgba(255,80,80,0.5)', offset: 0.30 },
    { transform: 'scale(1.18) translateY(-20px) translateX(-10px)', boxShadow: '0 0 0 4px #ff6b6b, 0 16px 32px rgba(255,80,80,0.5)', offset: 0.45 },
    { transform: 'scale(1.18) translateY(-20px) translateX(10px)',  boxShadow: '0 0 0 3px #ff6b6b', offset: 0.60 },
    { transform: 'scale(1.18) translateY(-20px) translateX(-5px)',  boxShadow: '0 0 0 2px #ff6b6b', offset: 0.78 },
    { transform: 'scale(1.18) translateY(-20px) translateX(0)',     boxShadow: '0 0 0 2px #ff6b6b' },
  ], { duration: 520, easing: 'linear' });

  // 4. Breve pausa: el jugador ve la carta que tenía
  await _wait(500);

  // 5. La carta regresa a su posición original
  await _anim(fly, [
    { transform: 'scale(1.18) translateY(-20px)', opacity: 1 },
    { transform: 'scale(1) translateY(0px)',       opacity: 0.6 },
  ], { duration: 280, easing: 'ease-in' });

  await _anim(fly, [
    { opacity: 0.6 },
    { opacity: 0 },
  ], { duration: 120, easing: 'ease-in' });

  fly.remove();

  // Pulso rojo en la carta en mesa
  const tableEl = document.getElementById('drawn-card-slot');
  if (tableEl) {
    const topCard = tableEl.querySelector('.top-card') || tableEl;
    topCard.classList.remove('pulse-err');
    void topCard.offsetWidth;
    topCard.classList.add('pulse-err');
    setTimeout(() => topCard.classList.remove('pulse-err'), 600);
  }
}

// ─── Carta de penalización ────────────────────────────────────────────────────

/**
 * Una carta boca abajo con borde rojo vuela del mazo al área del jugador.
 * @param {HTMLElement} playerAreaEl - El .player-area del jugador penalizado
 */
async function penaltyFly(playerAreaEl) {
  const deckEl = document.getElementById('deck-pile');
  if (!deckEl || !playerAreaEl) return;

  const fromRect = _r(deckEl);
  const toRect   = _r(playerAreaEl);

  const fly = _makeFlyingCard(fromRect, null); // boca abajo
  // Borde rojo desde el inicio
  fly.style.boxShadow = '0 0 0 3px #ff6b6b, 0 8px 24px rgba(255,80,80,0.5)';
  fly.style.border    = '2px solid #ff6b6b';

  // Levantar
  await _anim(fly, [
    { transform: 'scale(1) rotate(0deg)' },
    { transform: 'scale(1.15) rotate(-5deg)' },
  ], { duration: 130, easing: 'ease-out' });

  // Destino: si hay fila de cartas, apuntar a la primera posición a la izquierda
  const cardsContainer = playerAreaEl.querySelector('.player-cards');
  const firstCard = cardsContainer?.firstElementChild;
  let destRect;
  if (firstCard) {
    const fcRect = _r(firstCard);
    destRect = {
      left: fcRect.left,
      top:  fcRect.top,
    };
  } else {
    destRect = {
      left: toRect.left + (toRect.width  - fromRect.width)  / 2,
      top:  toRect.top  + (toRect.height - fromRect.height) / 2,
    };
  }

  // Volar con arco pronunciado hacia la izquierda de su mano
  await _fly(fly, destRect, 420, {
    arcHeight: -70,
    startScale: 1.15,
    endScale: 1.0,
    endRotate: 8,
    easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  });

  // Parpadeo rojo al llegar
  const dx2 = destRect.left - fromRect.left;
  const dy2 = destRect.top  - fromRect.top;

  await _anim(fly, [
    { boxShadow: '0 0 0 3px #ff6b6b, 0 4px 12px rgba(255,80,80,0.5)' },
    { boxShadow: '0 0 0 8px #ff4444, 0 4px 24px rgba(255,40,40,0.8)', offset: 0.3 },
    { boxShadow: '0 0 0 3px #ff6b6b, 0 4px 12px rgba(255,80,80,0.5)' },
  ], { duration: 350, easing: 'ease-out' });

  fly.remove();

  // Flash rojo en el área del jugador
  playerAreaEl.classList.remove('area-hit');
  void playerAreaEl.offsetWidth;
  playerAreaEl.classList.add('area-hit');
  setTimeout(() => playerAreaEl.classList.remove('area-hit'), 700);
}

// ─── Efectos en sitio ─────────────────────────────────────────────────────────

/** Destello dorado en el mazo al robar */
function deckGlow() {
  const deckEl = document.getElementById('deck-pile');
  if (!deckEl) return;
  deckEl.classList.remove('deck-glow');
  void deckEl.offsetWidth;
  deckEl.classList.add('deck-glow');
  setTimeout(() => deckEl.classList.remove('deck-glow'), 450);
}

/** Rebote en la carta en mesa al recibir una carta */
function tableLand() {
  const tableEl = document.getElementById('drawn-card-slot');
  if (!tableEl) return;
  const topCard = tableEl.querySelector('.top-card') || tableEl;
  topCard.classList.remove('table-land');
  void topCard.offsetWidth;
  topCard.classList.add('table-land');
  setTimeout(() => topCard.classList.remove('table-land'), 400);
}

/** Hace que el área del jugador activo rebote levemente para indicar turno */
function playerAreaBounce(playerAreaEl) {
  if (!playerAreaEl) return;
  playerAreaEl.animate([
    { transform: 'scale(1)' },
    { transform: 'scale(1.04)', offset: 0.4 },
    { transform: 'scale(1)' },
  ], { duration: 350, easing: 'cubic-bezier(0.22,1.1,0.36,1)' });
}

// ─── Exportar ─────────────────────────────────────────────────────────────────

const Anim = {
  shuffleDeckOnTable,
  drawFromDeck,
  flyCardToTable,
  copySuccess,
  copyFail,
  penaltyFly,
  toast,
  deckGlow,
  tableLand,
  playerAreaBounce,
};
