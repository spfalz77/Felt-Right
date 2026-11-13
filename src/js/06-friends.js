// ════════════════════════════════════════════════════════════════════════════
// FRIENDS
// ════════════════════════════════════════════════════════════════════════════
async function loadFriends() {
  if (!sb || me.id === 'demo') return;
  try {
    // Load accepted friends
    const { data } = await sb.from('friendships')
      .select(`id,status,requester_id,addressee_id,
        requester:users!requester_id(id,display_name,avatar_emoji),
        addressee:users!addressee_id(id,display_name,avatar_emoji)`)
      .or(`requester_id.eq.${me.id},addressee_id.eq.${me.id}`)
      .eq('status','accepted');
    myFriends = (data||[]).map(f => {
      const fr = f.requester_id === me.id ? f.addressee : f.requester;
      return {...fr, friendshipId: f.id};
    });
    renderFriendsList();

    // Load pending requests sent BY me (so we can show "Sent" in search)
    const { data: sent } = await sb.from('friendships')
      .select('addressee_id')
      .eq('requester_id', me.id)
      .eq('status', 'pending');
    myPendingSent = (sent || []).map(r => r.addressee_id);

    // Load pending requests sent TO me
    const { data: pending } = await sb.from('friendships')
      .select(`id,requester:users!requester_id(id,display_name,avatar_emoji)`)
      .eq('addressee_id', me.id)
      .eq('status','pending');
    renderPendingRequests(pending || []);

  } catch(e) { console.warn(e); }
}

function renderPendingRequests(requests) {
  const section = document.getElementById('friend-requests-section');
  const list = document.getElementById('friend-requests-list');
  if (!requests.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = requests.map(r => `
    <div class="list-row">
      <div class="avatar">${r.requester?.avatar_emoji || r.requester?.display_name[0] || '?'}</div>
      <div class="list-row-info">
        <div class="name">${r.requester?.display_name || 'Someone'}</div>
        <div class="sub">Wants to be friends</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="acceptFriend('${r.id}','${r.requester?.display_name}')">Accept</button>
    </div>`).join('');
}

async function acceptFriend(friendshipId, name) {
  try {
    await sb.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
    toast(`You and ${name} are now friends!`);
    loadFriends(); // refresh both lists
  } catch(e) { toast('Could not accept request'); }
}

function renderFriendsList() {
  const el = document.getElementById('friends-list');
  if (!myFriends.length) {
    el.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text-dim);font-size:0.9rem;font-style:italic;">No friends yet — search above.</div>`;
    return;
  }
  el.innerHTML = myFriends.map(f => `
    <div class="list-row" style="cursor:pointer" onclick="viewFriendProfile('${f.id}', '${(f.display_name||'').replace(/'/g, '&#39;')}', '${f.avatar_emoji||''}')">
      <div class="avatar">${f.avatar_emoji||f.display_name[0]}</div>
      <div class="list-row-info">
        <div class="name">${f.display_name}</div>
        <div class="sub">Tap to view stats</div>
      </div>
      <button onclick="event.stopPropagation();removeFriend('${f.friendshipId}','${(f.display_name||'').replace(/'/g, '&#39;')}')"
        style="background:none;border:1px solid rgba(192,57,43,0.3);color:var(--red-light);
          border-radius:50%;width:28px;height:28px;font-size:1.1rem;cursor:pointer;
          display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1">−</button>
    </div>`).join('');
}

async function viewFriendProfile(userId, name, emoji) {
  if (!sb || !userId) return;
  // Show modal with friend's public stats
  const stats = await loadOtherUserPublicStats(userId);

  let modal = document.getElementById('friend-profile-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'friend-profile-modal';
    modal.style.cssText = `
      position: fixed; inset: 0; z-index: 410;
      background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
      display: flex; align-items: flex-end;
    `;
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div onclick="event.stopPropagation()" style="background:var(--bg);width:100%;max-width:520px;margin:0 auto;
      border-radius:16px 16px 0 0;max-height:90vh;display:flex;flex-direction:column;
      border-top:1px solid var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="avatar" style="font-size:1.7rem">${emoji || (name||'?')[0]}</div>
          <div>
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:0.08em;color:var(--gold-pale)">
              ${name}
            </div>
            <div style="font-size:0.7rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.1em">
              Public Profile
            </div>
          </div>
        </div>
        <button onclick="closeFriendProfile()" style="background:none;border:none;color:var(--text-dim);
          font-size:1.6rem;cursor:pointer;padding:4px 10px;line-height:1">×</button>
      </div>
      <div style="overflow-y:auto;padding:16px">
        ${renderStatsHtml(stats, null, false)}
      </div>
    </div>
  `;

  modal.onclick = closeFriendProfile;
}

function closeFriendProfile() {
  const modal = document.getElementById('friend-profile-modal');
  if (modal) modal.remove();
}

async function removeFriend(friendshipId, name) {
  if (!confirm(`Remove ${name}?`)) return;
  if (me.id === 'demo') {
    myFriends = myFriends.filter(f => f.friendshipId !== friendshipId);
    renderFriendsList(); toast(`${name} removed`); return;
  }
  try {
    const { error } = await sb.from('friendships').delete().eq('id', friendshipId);
    if (error) throw error;
    // Remove from local cache immediately
    myFriends = myFriends.filter(f => f.friendshipId !== friendshipId);
    renderFriendsList();
    toast(`${name} removed`);
    // Also refresh from DB to confirm
    await loadFriends();
  } catch(e) {
    if (e.message?.includes('policy') || e.code === '42501') {
      toast('Run the delete policy SQL first — see setup guide');
    } else {
      toast('Could not remove: ' + e.message);
    }
  }
}

let searchTimer = null;
function searchFriends(q) {
  clearTimeout(searchTimer);
  const resultsSec = document.getElementById('friend-search-results');
  if (!q.trim()) { resultsSec.style.display='none'; return; }
  searchTimer = setTimeout(async () => {
    resultsSec.style.display = 'block';
    const list = document.getElementById('friend-results-list');
    if (me.id === 'demo') {
      // Demo: show fake results
      const fakeUsers = [
        { id:'x1', display_name:'Tyler B.', avatar_emoji:'♠' },
        { id:'x2', display_name:'Nicole P.', avatar_emoji:'♥' },
      ].filter(u => u.display_name.toLowerCase().includes(q.toLowerCase()));
      list.innerHTML = fakeUsers.length
        ? fakeUsers.map(u => userRow(u)).join('')
        : `<div style="padding:16px 20px;color:var(--text-dim);font-size:0.88rem">No results</div>`;
      return;
    }
    try {
      const { data } = await sb.from('users')
        .select('id,display_name,avatar_emoji,phone')
        .or(`display_name.ilike.%${q}%,phone.ilike.%${q}%`)
        .neq('id', me.id).limit(15);
      list.innerHTML = (data||[]).length
        ? (data||[]).map(u => userRow(u)).join('')
        : `<div style="padding:16px 20px;color:var(--text-dim);font-size:0.88rem">No results found</div>`;
    } catch(e) { list.innerHTML = `<div style="padding:16px 20px;color:var(--text-dim)">Error searching</div>`; }
  }, 350);
}

let myPendingSent = []; // IDs of users I've sent requests to

function userRow(u) {
  const isFriend = myFriends.some(f => f.id === u.id);
  const isPending = myPendingSent.includes(u.id);
  return `<div class="list-row">
    <div class="avatar">${u.avatar_emoji||u.display_name[0]}</div>
    <div class="list-row-info">
      <div class="name">${u.display_name}</div>
      <div class="sub" style="font-size:0.75rem">${u.phone ? u.phone.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3') : ''}</div>
    </div>
    ${isFriend
      ? `<span class="badge badge-green">Friends</span>`
      : isPending
        ? `<span class="badge badge-dim">Sent</span>`
        : `<button class="btn btn-ghost btn-sm" onclick="addFriend('${u.id}','${u.display_name}')">Add</button>`}
  </div>`;
}

async function addFriend(userId, name) {
  if (me.id === 'demo') {
    myFriends.push({ id: userId, display_name: name, avatar_emoji: '🃏' });
    renderFriendsList(); toast(`Added ${name}!`); return;
  }
  try {
    await sb.from('friendships').insert({ requester_id: me.id, addressee_id: userId });
    myPendingSent.push(userId);
    toast(`Friend request sent to ${name} ✓`);
    // Re-render search results to show Sent state
    const q = document.getElementById('friend-search').value;
    if (q) searchFriends(q);
  } catch(e) {
    if (e.message?.includes('duplicate')) toast('Request already sent');
    else toast('Could not send request');
  }
}

function copyInviteLink() {
  const link = `${appBaseUrl()}?invite=true`;
  navigator.clipboard?.writeText(link).then(() => toast('Invite link copied!'));
}

