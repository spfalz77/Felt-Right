// Side pots.
// Shared by the browser app (inlined by scripts/build.mjs, which strips the
// import/export keywords) and the server (supabase/functions/table).
// Pure functions only: no DOM, no globals.

// ── SIDE POT BUILDER ─────────────────────────────────────────────────────────
// Returns array of { amount, eligible[] } sorted smallest → largest cap
export function buildSidePots(players, handNumber) {
  // Build side pots from totalBet contributions across all players (including folded).
  // Standard poker side-pot algorithm:
  //   1. Find all distinct totalBet "levels" (sorted ascending).
  //   2. For each level, build a pot containing (level - prevLevel) from EVERY player
  //      who contributed at least `level` chips (folded or not — their chips stay in).
  //   3. Eligibility for that pot = players who contributed at least `level` AND haven't folded.
  // This correctly handles: multiple all-ins, folded players who contributed, uncalled overage
  // (which should already have been returned by returnUncalledBets before this is called).

  // A player who quit during this hand has left the table (eliminated) but the
  // chips they already bet stay in the pot (they're folded, so can't win it).
  // (The browser app doesn't pass handNumber; it falls back to its global G.)
  const handNo = handNumber !== undefined ? handNumber : ((typeof G !== 'undefined' && G) ? G.handNumber : undefined);
  const contributors = players.filter(p => (!p.eliminated || (p.quitHand != null && p.quitHand === handNo)) && p.totalBet > 0);
  if (!contributors.length) return [];

  // Distinct totalBet levels in ascending order
  const levels = [...new Set(contributors.map(p => p.totalBet))].sort((a, b) => a - b);

  const pots = [];
  let prev = 0;
  for (const level of levels) {
    const slice = level - prev;
    if (slice <= 0) continue;
    let amount = 0;
    for (const p of contributors) {
      // Each player contributes min(slice, their remaining stake above prev)
      const contribution = Math.max(0, Math.min(slice, p.totalBet - prev));
      amount += contribution;
    }
    // Eligible to win = contributors whose totalBet >= level AND not folded
    const eligible = contributors.filter(p => p.totalBet >= level && !p.folded);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }

  // Consolidate consecutive pots that have identical eligibility sets
  const merged = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    const sameElig = last &&
      last.eligible.length === pot.eligible.length &&
      last.eligible.every((p, i) => p.id === pot.eligible[i].id);
    if (sameElig) last.amount += pot.amount;
    else merged.push({ amount: pot.amount, eligible: [...pot.eligible] });
  }

  // Sanity: total pot amounts should equal sum of all totalBets
  const computedTotal = merged.reduce((s, p) => s + p.amount, 0);
  const expectedTotal = contributors.reduce((s, p) => s + p.totalBet, 0);
  if (computedTotal !== expectedTotal) {
    console.warn('Side pot mismatch:', { computedTotal, expectedTotal, gPot: G?.pot });
  }

  return merged;
}
