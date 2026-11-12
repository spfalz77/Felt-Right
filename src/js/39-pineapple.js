// ════════════════════════════════════════════════════════════════════════════
// PINEAPPLE / CRAZY PINEAPPLE — DISCARD
// ════════════════════════════════════════════════════════════════════════════
// Server games only. Everyone still in the hand throws away one of their 3
// hole cards at the same time (Pineapple: right after the deal; Crazy
// Pineapple: once the flop is out). The server picks for anyone who doesn't
// answer in time (DISCARD_SECONDS), then the hand plays on as Hold'em.
let _discardTimer = null;
let _discardRenderKey = null;
let _discardSending = false;

// Players who still hold 3 cards this hand
function discardWaitingOn() {
  if (!G || G.stage !== 'discard') return [];
  const keep = (VARIANTS[G.variant] || {}).keepCards || 2;
  return G.players.filter(p => !p.folded && !p.eliminated && (p.hand || []).length > keep);
}

function showDiscardPicker() {
  const bar = document.getElementById('action-bar');
  if (!bar || !G || G.stage !== 'discard') return;
  const autoBar = document.getElementById('auto-action-bar');
  if (autoBar) autoBar.innerHTML = '';
  const waiting = discardWaitingOn();
  const inHand = G.players.filter(p => !p.folded && !p.eliminated);
  const myP = G.players.find(p => p.id === me.id);
  const mine = myP && waiting.includes(myP) && myP.hand.every(c => c && c.rank) ? myP.hand : null;
  const key = `${G.handNumber}|${G.dealSeq}|${mine ? mine.map(c => c.rank + c.suit).join(',') : '-'}|${waiting.length}|${_discardSending}`;
  if (key !== _discardRenderKey) {
    _discardRenderKey = key;
    const done = inHand.length - waiting.length;
    const when = (VARIANTS[G.variant] || {}).discardAt === 'flop' ? 'Flop’s out — ' : '';
    if (mine && !_discardSending) {
      const cardsHtml = mine.map((c, i) => `
        <button onclick="discardCard(${i})" class="card lg ${isRed(c) ? 'red' : 'black'}"
          style="cursor:pointer;border:none;padding:0;position:relative" aria-label="Discard ${c.rank}${c.suit}">
          <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
          <div class="card-center">${c.suit}</div>
          <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
        </button>`).join('');
      bar.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:6px 8px">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.05rem;letter-spacing:0.1em;color:var(--gold)">
            ${when}TAP A CARD TO DISCARD</div>
          <div id="discard-cards" style="display:flex;gap:10px;justify-content:center;margin:8px 0">${cardsHtml}</div>
          <div id="discard-timer-text" style="font-family:'Bebas Neue',sans-serif;color:var(--gold-pale);font-size:0.9rem">⏱ —</div>
        </div>`;
    } else {
      bar.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:8px">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.05rem;letter-spacing:0.1em;color:var(--text-dim)">
            ${myP && waiting.includes(myP) ? 'DEALING…' : myP && inHand.includes(myP) ? 'DISCARDED' : 'DISCARDING'}</div>
          <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">
            Waiting for others… ${done}/${inHand.length} discarded</div>
          <div id="discard-timer-text" style="font-family:'Bebas Neue',sans-serif;color:var(--gold-pale);margin-top:6px;font-size:0.95rem">⏱ —</div>
        </div>`;
    }
  }
  updateDiscardTimer();
  if (!_discardTimer) {
    _discardTimer = setInterval(() => {
      if (!G || G.stage !== 'discard') { clearInterval(_discardTimer); _discardTimer = null; _discardRenderKey = null; return; }
      updateDiscardTimer();
    }, 1000);
  }
}

function updateDiscardTimer() {
  const el = document.getElementById('discard-timer-text');
  if (!el || !G?.discardDeadline) return;
  const secLeft = Math.max(0, Math.ceil((G.discardDeadline - serverNow()) / 1000));
  el.style.color = secLeft < 5 ? 'var(--red-light)' : 'var(--gold-pale)';
  el.textContent = `⏱ ${secLeft}s · then one is picked for you`;
}

async function discardCard(index) {
  if (!G || G.stage !== 'discard' || _discardSending || !isServerGame()) return;
  _discardSending = true;
  showDiscardPicker();
  const { error } = await callTable(currentGameId, 'discard', index);
  _discardSending = false;
  if (error) { toast(error); _discardRenderKey = null; refreshGuestState(); return; }
  // Show my two cards right away; the server's copy follows
  if (_myPrivateHand && _myPrivateHand.handNumber === G.handNumber && _myPrivateHand.cards.length === 3) {
    _myPrivateHand = { ..._myPrivateHand, cards: _myPrivateHand.cards.filter((_, i) => i !== index) };
  }
  if (G.handNumber > 0) fetchMyPrivateHand(currentGameId, G.handNumber);
}

// Tournament create screen: Pineapple variants only for games this phone runs on the server
document.querySelectorAll('.server-only-variant').forEach((el) => { el.style.display = SERVER_RULES ? '' : 'none'; });
