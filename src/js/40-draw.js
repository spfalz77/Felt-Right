// ════════════════════════════════════════════════════════════════════════════
// 5-CARD DRAW — THE DRAW
// ════════════════════════════════════════════════════════════════════════════
// Server games only. After the first betting round everyone in the hand picks
// up to 3 cards to throw away, at the same time, and gets new ones. No pick
// in time (DRAW_SECONDS) means standing pat.
let _drawTimer = null;
let _drawRenderKey = null;
let _drawSending = false;
let _drawPicked = new Set();
let _drawPickedFor = null; // which hand the picks belong to

// Players who haven't drawn yet this hand
function drawWaitingOn() {
  if (!G || G.stage !== 'draw') return [];
  return G.players.filter(p => !p.folded && !p.eliminated && G.draws?.[p.id] == null);
}

function showDrawPicker() {
  const bar = document.getElementById('action-bar');
  if (!bar || !G || G.stage !== 'draw') return;
  const autoBar = document.getElementById('auto-action-bar');
  if (autoBar) autoBar.innerHTML = '';
  if (_drawPickedFor !== G.handNumber) { _drawPicked = new Set(); _drawPickedFor = G.handNumber; }
  const waiting = drawWaitingOn();
  const inHand = G.players.filter(p => !p.folded && !p.eliminated);
  const myP = G.players.find(p => p.id === me.id);
  const mine = myP && waiting.includes(myP) && myP.hand.every(c => c && c.rank) ? myP.hand : null;
  const max = (VARIANTS[G.variant] || {}).maxDraw || 3;
  const key = `${G.handNumber}|${G.dealSeq}|${mine ? mine.map(c => c.rank + c.suit).join(',') : '-'}|${waiting.length}|${_drawSending}|${[..._drawPicked].join(',')}`;
  if (key !== _drawRenderKey) {
    _drawRenderKey = key;
    if (mine && !_drawSending) {
      const n = _drawPicked.size;
      const cardsHtml = mine.map((c, i) => `
        <button onclick="toggleDrawCard(${i})" class="card lg ${isRed(c) ? 'red' : 'black'}${_drawPicked.has(i) ? ' picked' : ''}"
          style="cursor:pointer;border:none;padding:0;position:relative;transition:transform 0.12s"
          aria-pressed="${_drawPicked.has(i)}" aria-label="${c.rank}${c.suit}">
          <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
          <div class="card-center">${c.suit}</div>
          <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
        </button>`).join('');
      bar.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:6px 8px">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.05rem;letter-spacing:0.1em;color:var(--gold)">
            TAP UP TO ${max} CARDS TO REPLACE</div>
          <div id="draw-cards" class="my-cards five" style="margin:12px 0 8px">${cardsHtml}</div>
          <button id="draw-submit" onclick="submitDraw()" class="btn btn-primary"
            style="width:100%;padding:12px;font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:0.1em">
            ${n ? `DRAW ${n}` : 'STAND PAT'}</button>
          <div id="draw-timer-text" style="font-family:'Bebas Neue',sans-serif;color:var(--gold-pale);font-size:0.9rem;margin-top:6px">⏱ —</div>
        </div>`;
    } else {
      const done = inHand.length - waiting.length;
      bar.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:8px">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.05rem;letter-spacing:0.1em;color:var(--text-dim)">
            ${myP && waiting.includes(myP) ? 'DEALING…' : myP && inHand.includes(myP) ? 'NEW CARDS IN' : 'DRAWING'}</div>
          <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">
            Waiting for others… ${done}/${inHand.length} drawn</div>
          <div id="draw-timer-text" style="font-family:'Bebas Neue',sans-serif;color:var(--gold-pale);margin-top:6px;font-size:0.95rem">⏱ —</div>
        </div>`;
    }
  }
  updateDrawTimer();
  if (!_drawTimer) {
    _drawTimer = setInterval(() => {
      if (!G || G.stage !== 'draw') { clearInterval(_drawTimer); _drawTimer = null; _drawRenderKey = null; return; }
      updateDrawTimer();
    }, 1000);
  }
}

function updateDrawTimer() {
  const el = document.getElementById('draw-timer-text');
  if (!el || !G?.drawDeadline) return;
  const secLeft = Math.max(0, Math.ceil((G.drawDeadline - serverNow()) / 1000));
  el.style.color = secLeft < 5 ? 'var(--red-light)' : 'var(--gold-pale)';
  el.textContent = `⏱ ${secLeft}s · then you stand pat`;
}

function toggleDrawCard(i) {
  if (!G || G.stage !== 'draw' || _drawSending) return;
  const max = (VARIANTS[G.variant] || {}).maxDraw || 3;
  if (_drawPicked.has(i)) _drawPicked.delete(i);
  else if (_drawPicked.size < max) _drawPicked.add(i);
  else { toast(`You can draw at most ${max}`); return; }
  showDrawPicker();
}

async function submitDraw() {
  if (!G || G.stage !== 'draw' || _drawSending || !isServerGame()) return;
  _drawSending = true;
  showDrawPicker();
  const picks = [..._drawPicked].sort((a, b) => a - b);
  const { error } = await callTable(currentGameId, 'draw', picks);
  _drawSending = false;
  _drawPicked = new Set();
  _drawRenderKey = null;
  if (error) { toast(error); refreshGuestState(); return; }
  if (G.handNumber > 0) fetchMyPrivateHand(currentGameId, G.handNumber);
}
