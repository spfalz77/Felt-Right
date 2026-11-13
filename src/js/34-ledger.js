// ════════════════════════════════════════════════════════════════════════════
// STANDINGS — how you've done against each friend, in play chips
// ════════════════════════════════════════════════════════════════════════════
// Every finished game writes payout_ledger rows, one per pair of players, from
// each player's own side (kind='game'). Tournament rows are written by the
// server when a tournament ends; home games by settle_home_game_ledger.
// amount is stored in hundreds of chips (an old "dollars" column): show it ×100.
//
// Standings are lifetime totals: every kind='game' row counts, whether or not
// it was marked settled under the old settle-up flow. Old kind='settle' rows
// are ignored. There is no settling, owing or paying anywhere in the app.

// Ask the server to (re)write a home game's rows for all players.
// Returns { final, ledger_rows } or { skipped } / { error }, or null on failure.
async function settleHomeGameLedger(gameId) {
  if (!sb || !gameId || me.id === 'demo') return null;
  try {
    const { data, error } = await sb.rpc('settle_home_game_ledger', { p_game_id: gameId });
    if (error) { console.warn('settleHomeGameLedger:', error); return null; }
    return data;
  } catch(e) { console.warn('settleHomeGameLedger:', e); return null; }
}

// Pure: fold my own rows into per-friend head-to-head records.
// rows: [{ opponent_id, amount, kind, game_id, created_at, opponent? }]
// Returns { total, games, friends: [{ id, name, emoji, net, games, wins, losses, last }] }
// with net in chips. Only rows from my own side should be passed (user_id = me),
// or each game would count twice.
function computeStandings(rows) {
  const map = new Map();
  const myGames = new Set();
  let total = 0;
  for (const row of (rows || [])) {
    if (row.kind !== 'game' || !row.opponent_id) continue;
    const chips = Math.round((Number(row.amount) || 0) * 100);
    const id = row.opponent_id;
    if (!map.has(id)) {
      map.set(id, {
        id,
        name: row.opponent?.display_name || 'Player',
        emoji: row.opponent?.avatar_emoji || '🃏',
        net: 0, gameNets: new Map(), last: null,
      });
    }
    const f = map.get(id);
    f.net += chips;
    total += chips;
    const g = row.game_id || row.id;
    f.gameNets.set(g, (f.gameNets.get(g) || 0) + chips);
    myGames.add(g);
    if (!f.last || (row.created_at && row.created_at > f.last)) f.last = row.created_at || f.last;
  }
  const friends = Array.from(map.values()).map(f => {
    const nets = Array.from(f.gameNets.values());
    return {
      id: f.id, name: f.name, emoji: f.emoji, net: f.net, last: f.last,
      games: nets.length,
      wins: nets.filter(n => n > 0).length,
      losses: nets.filter(n => n < 0).length,
    };
  });
  friends.sort((a, b) => b.net - a.net || b.games - a.games || a.name.localeCompare(b.name));
  return { total, games: myGames.size, friends };
}

async function loadStandings() {
  if (!sb || me.id === 'demo') return computeStandings([]);
  const { data, error } = await sb.from('payout_ledger')
    .select('id, game_id, opponent_id, amount, kind, created_at, opponent:users!opponent_id(id, display_name, avatar_emoji)')
    .eq('user_id', me.id)
    .eq('kind', 'game')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return computeStandings(data || []);
}

function standingsColor(net) {
  return net > 0 ? 'var(--gold)' : net < 0 ? 'var(--red-light)' : 'var(--text-dim)';
}

async function renderLedger() {
  const el = document.getElementById('friends-ledger-list');
  if (!el) return;
  el.innerHTML = `<div style="color:var(--text-dim);font-size:0.85rem;padding:8px 0">Loading…</div>`;
  let s;
  try { s = await loadStandings(); }
  catch (e) {
    console.warn('loadStandings:', e);
    el.innerHTML = `<div style="color:var(--red-light);font-size:0.85rem;padding:8px 0">Couldn't load standings. Tap Refresh to try again.</div>`;
    return;
  }
  if (!s.friends.length) {
    el.innerHTML = `<div style="color:var(--text-dim);font-size:0.85rem;padding:14px 0;font-style:italic;text-align:center">No results yet. Finish a game with friends to see how you stack up.</div>`;
    return;
  }
  const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const overall = `
    <div style="display:flex;align-items:baseline;justify-content:space-between;padding:10px 12px;margin-bottom:8px;
      background:rgba(212,168,67,0.08);border:1px solid var(--gold-dim);border-radius:10px">
      <div>
        <div style="font-weight:600;font-size:0.9rem">You overall</div>
        <div style="font-size:0.72rem;color:var(--text-dim)">${s.games} game${s.games === 1 ? '' : 's'} with friends</div>
      </div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;letter-spacing:0.05em;color:${standingsColor(s.total)}">
        ${chipNet(s.total)} <span style="font-size:0.8rem;color:var(--text-dim)">chips</span>
      </div>
    </div>`;
  el.innerHTML = overall + s.friends.map((f, i) => {
    const record = `${f.wins}–${f.losses}${f.games - f.wins - f.losses ? '–' + (f.games - f.wins - f.losses) : ''}`;
    const verdict = f.net > 0 ? `you're up` : f.net < 0 ? `you're down` : 'even';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;
        background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:6px">
        <div style="width:18px;text-align:right;font-size:0.75rem;color:var(--text-dim)">${i + 1}</div>
        <div class="avatar sm">${f.emoji}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;font-size:0.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">vs ${esc(f.name)}</div>
          <div style="font-size:0.72rem;color:var(--text-dim)">
            ${f.games} game${f.games === 1 ? '' : 's'} · record ${record} · ${verdict}
          </div>
        </div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.2rem;letter-spacing:0.05em;color:${standingsColor(f.net)}">
          ${chipNet(f.net)}
        </div>
      </div>`;
  }).join('');
}
