// Tournament prize-pool split.
// Shared by the browser app (inlined by scripts/build.mjs, which strips the
// import/export keywords) and the server (supabase/functions/table).
// Pure functions only: no DOM, no globals.

// ── PAYOUT CALCULATION ──
// Round up to nearest $10
export function roundUpTo10(amount) {
  return Math.ceil(amount / 10) * 10;
}

// Compute how the prize pool is distributed.
// Returns array of { placement: 1|2|3, amount: $ } or for chops, equal splits.
export function computePayouts(buyIn, totalPlayers, isChop, actualPoolOverride) {
  // pool = sum of all dollars contributed (buy-ins + rebuys + add-ons).
  // For tournaments without rebuys, this equals buyIn × totalPlayers.
  // For tournaments WITH rebuys, the caller passes the actual pool computed
  // from sum of player totalBuyInCents.
  const pool = actualPoolOverride != null ? actualPoolOverride : (buyIn || 0) * (totalPlayers || 0);
  if (pool <= 0) return [];

  // For 7+ players, 3rd still gets buy-in back even if a chop happens
  const thirdGetsPayout = totalPlayers >= 7;
  const thirdShare = thirdGetsPayout ? buyIn : 0;
  const topTwoPool = pool - thirdShare;

  if (isChop) {
    const half = topTwoPool / 2;
    const result = [
      { placement: 1, amount: half, label: 'Chop' },
      { placement: 2, amount: half, label: 'Chop' },
    ];
    if (thirdGetsPayout) result.push({ placement: 3, amount: thirdShare });
    return result;
  }

  if (totalPlayers <= 4) {
    return [{ placement: 1, amount: pool }];
  }

  if (totalPlayers <= 6) {
    const winnerShare = roundUpTo10(pool * 0.75);
    const secondShare = pool - winnerShare;
    return [
      { placement: 1, amount: winnerShare },
      { placement: 2, amount: secondShare },
    ];
  }

  const winnerShare = roundUpTo10(topTwoPool * 0.75);
  const secondShare = topTwoPool - winnerShare;
  return [
    { placement: 1, amount: winnerShare },
    { placement: 2, amount: secondShare },
    { placement: 3, amount: thirdShare },
  ];
}

// Helper: compute the actual prize pool from G state (sums all rebuy/add-on contributions).
// Returns dollars (not cents).

// Friends Ledger entries for a finished tournament, as pairs: each loser owes
// each winner a share of their loss in proportion to that winner's net win.
// Same math the app used when each player recorded their own rows.
// Returns [{ winner, loser, dollars }] (player ids), or [] when there's
// nothing to record (home game, not over, no buy-in).
export function tournamentLedger(G) {
  if (!G || G.format === 'home' || !G.tournamentOver) return [];
  const buyIn = G.buyIn || 0;
  if (buyIn <= 0 || !G.players?.length) return [];
  const paidCents = (p) => p.totalBuyInCents || buyIn * 100;
  const pool = G.rebuysEnabled ? G.players.reduce((s, p) => s + paidCents(p), 0) / 100 : null;
  const payouts = computePayouts(buyIn, G.players.length, !!G.chopped, pool);

  const net = {};
  for (const p of G.players) net[p.id] = G.rebuysEnabled ? -paidCents(p) / 100 : -buyIn;
  const order = (G.finalPlacements || []).map((fp) => G.players.find((p) => p.name === fp.name)).filter(Boolean);
  payouts.forEach((po, i) => { if (order[i]) net[order[i].id] += po.amount; });

  const winners = Object.entries(net).filter(([, n]) => n > 0);
  const losers = Object.entries(net).filter(([, n]) => n < 0);
  const total = winners.reduce((s, [, n]) => s + n, 0);
  if (total <= 0) return [];
  const pairs = [];
  for (const [winner, win] of winners) {
    for (const [loser, loss] of losers) {
      const dollars = Math.round((win / total) * Math.abs(loss) * 100) / 100;
      if (dollars > 0) pairs.push({ winner, loser, dollars });
    }
  }
  return pairs;
}
