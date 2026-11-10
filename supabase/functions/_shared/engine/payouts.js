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
