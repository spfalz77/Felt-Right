// ════════════════════════════════════════════════════════════════════════════
// PAYOUT LEDGER — track winnings/losses across games with friends
// ════════════════════════════════════════════════════════════════════════════
// Each game produces ledger rows: one per pair of (winner, loser) with the amount
// the loser owes the winner. We use kind='game' for these. Manual settle-ups
// use kind='settle' and have a negative amount that cancels prior balance.

// Tournament ledger rows are written by the server when a tournament ends
// (both sides of every pair); home games by settle_home_game_ledger. Phones
// only add their own settle-up rows.

// Ask the server to (re)write a home game's ledger entries for all players.
// Returns { final, ledger_rows } or { skipped } / { error }, or null on failure.
async function settleHomeGameLedger(gameId) {
  if (!sb || !gameId || me.id === 'demo') return null;
  try {
    const { data, error } = await sb.rpc('settle_home_game_ledger', { p_game_id: gameId });
    if (error) { console.warn('settleHomeGameLedger:', error); return null; }
    return data;
  } catch(e) { console.warn('settleHomeGameLedger:', e); return null; }
}

async function loadMyLedger() {
  if (!sb || me.id === 'demo') return [];
  try {
    const { data } = await sb.from('payout_ledger')
      .select('*, opponent:users!opponent_id(id, display_name, avatar_emoji)')
      .or(`user_id.eq.${me.id},opponent_id.eq.${me.id}`)
      .is('settled_at', null)
      .order('created_at', { ascending: false });
    return data || [];
  } catch(e) { console.warn('loadMyLedger:', e); return []; }
}

// Compute pairwise net balances from ledger rows.
// Returns array of { id, name, emoji, balance } where positive balance = they owe me.
// We only count rows WHERE user_id = me.id (my own perspective). If a row has me as
// opponent_id but a different user_id, it's the OTHER user's record of OUR transaction —
// we'd double-count if we included it.
async function computePairwiseBalances() {
  if (!sb || me.id === 'demo') return [];
  const { data: myRows } = await sb.from('payout_ledger')
    .select('*, opponent:users!opponent_id(id, display_name, avatar_emoji)')
    .eq('user_id', me.id)
    .is('settled_at', null)
    .order('created_at', { ascending: false });

  const map = new Map();
  for (const row of (myRows || [])) {
    const oppId = row.opponent_id;
    if (!oppId) continue;
    const oppName = row.opponent?.display_name || 'Player';
    const oppEmoji = row.opponent?.avatar_emoji || '🃏';
    if (!map.has(oppId)) map.set(oppId, { id: oppId, name: oppName, emoji: oppEmoji, balance: 0, rowIds: [] });
    const entry = map.get(oppId);
    entry.balance += row.amount;
    entry.rowIds.push(row.id);
  }
  return Array.from(map.values()).filter(e => Math.abs(e.balance) > 0.005);
}

async function settleUpWith(opponentId, opponentName, balance) {
  if (!sb || me.id === 'demo') return;
  // balance > 0 means opponent owes me. The settle-up offsets it.
  // From my perspective: amount = -balance (cancel out my positive)
  // Opponent records: amount = +balance (cancel out their negative)
  // Both rows kind='settle'.
  if (!confirm(`Mark $${Math.abs(balance).toFixed(2)} as settled with ${opponentName}? This cannot be undone.`)) return;

  try {
    // I record my own settle row
    await sb.from('payout_ledger').insert({
      user_id: me.id,
      opponent_id: opponentId,
      amount: -balance,
      kind: 'settle',
      note: 'Settled up',
    });
    // Mark the existing rows as settled so they drop out of balance calculations
    // (only my rows — opponent has to do their own)
    await sb.from('payout_ledger').update({ settled_at: new Date().toISOString() })
      .eq('user_id', me.id)
      .eq('opponent_id', opponentId)
      .is('settled_at', null);
    toast(`Settled with ${opponentName}`);
    if (typeof renderLedger === 'function') renderLedger();
  } catch(e) {
    toast('Settle failed: ' + (e.message || e));
  }
}

async function renderLedger() {
  const el = document.getElementById('friends-ledger-list');
  if (!el) return;
  el.innerHTML = `<div style="color:var(--text-dim);font-size:0.85rem;padding:8px 0">Loading…</div>`;
  const balances = await computePairwiseBalances();
  if (!balances.length) {
    el.innerHTML = `<div style="color:var(--text-dim);font-size:0.85rem;padding:14px 0;font-style:italic;text-align:center">No outstanding balances. Play games with buy-ins to see who owes who.</div>`;
    return;
  }
  // Sort by absolute balance descending
  balances.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  el.innerHTML = balances.map(b => {
    const owesMe = b.balance > 0;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;
        background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:6px">
        <div class="avatar sm">${b.emoji}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;font-size:0.9rem">${b.name}</div>
          <div style="font-size:0.72rem;color:${owesMe?'var(--gold-pale)':'var(--red-light)'}">
            ${owesMe ? `owes you` : `you owe`}
          </div>
        </div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.2rem;
          color:${owesMe?'var(--gold)':'var(--red-light)'};letter-spacing:0.05em">
          $${Math.abs(b.balance).toFixed(b.balance % 1 === 0 ? 0 : 2)}
        </div>
        <button onclick="settleUpWith('${b.id}','${b.name.replace(/'/g, '&#39;')}',${b.balance})"
          style="background:none;border:1px solid var(--gold-dim);color:var(--gold);
            font-size:0.72rem;padding:5px 10px;border-radius:6px;cursor:pointer">Settle</button>
      </div>`;
  }).join('');
}

