// ════════════════════════════════════════════════════════════════════════════
// PAYOUT LEDGER — track winnings/losses across games with friends
// ════════════════════════════════════════════════════════════════════════════
// Each game produces ledger rows: one per pair of (winner, loser) with the amount
// the loser owes the winner. We use kind='game' for these. Manual settle-ups
// use kind='settle' and have a negative amount that cancels prior balance.

async function recordGameToLedger(gameId, buyIn, totalPlayers, finalPlacements, isChop) {
  if (!sb || me.id === 'demo' || !buyIn || buyIn <= 0) return { error: 'no buyin' };

  // Same actual-pool logic as the overlay: rebuys add to prize pool
  const actualPool = G?.rebuysEnabled ? actualPrizePool() : null;
  const payouts = computePayouts(buyIn, totalPlayers, isChop, actualPool);
  if (!payouts.length) return { error: 'no payouts' };

  // Find each player's user_id from G.players (matched by name+emoji to finalPlacements)
  // finalPlacements has { name, emoji, chips } but we need user_ids.
  // Use G.players as the source of truth.
  if (!G || !G.players) return { error: 'no game state' };

  // Build placement -> player mapping from finalPlacements
  const placementOrder = finalPlacements.map(fp => {
    return G.players.find(p => p.name === fp.name);
  }).filter(Boolean);

  // Net per user: positive = winner, negative = loser
  // Each player put in buyIn; each finisher receives their placement amount.
  const netByUser = {};
  for (const player of G.players) {
    if (!player.id || player.id === 'demo') continue;
    // They paid the buy-in plus any re-buys/add-ons (with re-buys on)
    netByUser[player.id] = G.rebuysEnabled ? -buyInCentsOf(player) / 100 : -buyIn;
  }
  // Distribute payouts
  payouts.forEach((payout, idx) => {
    const player = placementOrder[idx];
    if (!player) return;
    netByUser[player.id] = (netByUser[player.id] || 0) + payout.amount;
  });

  // Build pairwise debts: each loser owes each winner proportionally
  const winners = Object.entries(netByUser).filter(([_, n]) => n > 0);
  const losers = Object.entries(netByUser).filter(([_, n]) => n < 0);
  const totalWinnings = winners.reduce((s, [_, n]) => s + n, 0);
  if (totalWinnings <= 0) return { error: 'no winners' };

  const rows = [];
  for (const [winnerId, winAmt] of winners) {
    for (const [loserId, lossAmt] of losers) {
      // Loser owes the winner a share = (winner's win / total winnings) * loser's loss
      const owe = Math.round((winAmt / totalWinnings) * Math.abs(lossAmt) * 100) / 100;
      if (owe <= 0) continue;
      // Each user creates their OWN row (RLS: auth.uid() = user_id)
      // From the winner's perspective: they receive `owe` from opponent_id (loser)
      if (winnerId === me.id) {
        rows.push({
          game_id: gameId,
          user_id: winnerId,
          opponent_id: loserId,
          amount: owe,
          kind: 'game',
          note: `Game payout`,
        });
      }
      // From the loser's perspective: they owe `owe` to opponent_id (winner)
      if (loserId === me.id) {
        rows.push({
          game_id: gameId,
          user_id: loserId,
          opponent_id: winnerId,
          amount: -owe,
          kind: 'game',
          note: `Game buy-in`,
        });
      }
    }
  }

  if (!rows.length) return { error: 'no rows for me' };
  try {
    const { error } = await sb.from('payout_ledger').insert(rows);
    if (error) return { error };
    return { ok: true, count: rows.length };
  } catch(e) { return { error: e }; }
}

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

