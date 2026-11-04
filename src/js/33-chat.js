// ════════════════════════════════════════════════════════════════════════════
// CHAT (backend only - UI comes later)
// ════════════════════════════════════════════════════════════════════════════
let _chatSubscription = null;
let _chatCurrentGameId = null;
let _chatMessages = []; // array of {id, game_id, sender_id, sender_name, text, created_at}
let _chatUnreadCount = 0;
const _chatListeners = new Set(); // callbacks to notify on new message

function subscribeToChatForGame(gameId) {
  if (!sb || !gameId || me.id === 'demo') return;
  // Already subscribed to this game's chat - skip
  if (_chatSubscription && _chatCurrentGameId === gameId) return;
  if (_chatSubscription) _chatSubscription.unsubscribe();
  _chatCurrentGameId = gameId;
  _chatMessages = [];
  _chatUnreadCount = 0;

  // Load recent history
  loadChatHistory(gameId);

  _chatSubscription = sb.channel(`chat:${gameId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'game_messages',
      filter: `game_id=eq.${gameId}`,
    }, payload => {
      const msg = payload.new;
      // Skip our own messages (already added optimistically) AND any duplicate
      if (_chatMessages.find(m => m.id === msg.id)) return;
      // Replace any optimistic message that matches our text/sender
      if (msg.sender_id === me.id) {
        const optIdx = _chatMessages.findIndex(m => m._optimistic && m.sender_id === me.id && m.text === msg.text);
        if (optIdx >= 0) {
          _chatMessages[optIdx] = msg;
          _chatListeners.forEach(cb => cb({ type: 'history', messages: _chatMessages }));
          return;
        }
      }
      _chatMessages.push(msg);
      // If it's not our own and chat panel isn't open, increment unread
      if (msg.sender_id !== me.id) {
        const panelOpen = document.getElementById('chat-panel')?.style.display === 'flex';
        if (!panelOpen) _chatUnreadCount++;
      }
      _chatListeners.forEach(cb => cb({ type: 'new', message: msg, unread: _chatUnreadCount }));
    })
    .subscribe();
}

// Separate so we can call it again on visibility-change to catch any messages we missed while hidden
async function loadChatHistory(gameId) {
  if (!sb || !gameId) return;
  try {
    const { data } = await sb.from('game_messages')
      .select('id, sender_id, sender_name, sender_emoji, text, created_at')
      .eq('game_id', gameId)
      .order('created_at', { ascending: true })
      .limit(200);
    if (data) {
      _chatMessages = data;
      _chatListeners.forEach(cb => cb({ type: 'history', messages: data }));
    }
  } catch(e) { console.warn('loadChatHistory:', e); }
}

function unsubscribeFromChat() {
  if (_chatSubscription) { _chatSubscription.unsubscribe(); _chatSubscription = null; }
  _chatCurrentGameId = null;
  _chatMessages = [];
  _chatUnreadCount = 0;
}

async function sendChatMessage(text) {
  const gameId = currentGameId || currentLobbyId;
  if (!sb || !gameId || me.id === 'demo') return { error: 'not available' };
  const trimmed = (text || '').trim();
  if (!trimmed) return { error: 'empty' };
  if (trimmed.length > 500) return { error: 'too long' };

  // Optimistic append so the sender sees their message instantly,
  // even before the realtime echo arrives. Use a synthetic id; if the realtime
  // event comes through later with a matching server id, the dedupe in
  // subscribeToChatForGame won't see it as a duplicate (different id) — that's
  // OK because by then we'll have replaced our local copy below.
  const optimisticMsg = {
    id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    sender_id: me.id,
    sender_name: me.display_name || 'Player',
    sender_emoji: me.avatar_emoji || '🃏',
    text: trimmed,
    created_at: new Date().toISOString(),
    _optimistic: true,
  };
  _chatMessages.push(optimisticMsg);
  _chatListeners.forEach(cb => cb({ type: 'new', message: optimisticMsg, unread: 0 }));

  const { data, error } = await sb.from('game_messages').insert({
    game_id: gameId,
    sender_id: me.id,
    sender_name: me.display_name || 'Player',
    sender_emoji: me.avatar_emoji || '🃏',
    text: trimmed,
  }).select().single();

  if (error) {
    // Remove the optimistic message on failure
    const idx = _chatMessages.findIndex(m => m.id === optimisticMsg.id);
    if (idx >= 0) _chatMessages.splice(idx, 1);
    _chatListeners.forEach(cb => cb({ type: 'history', messages: _chatMessages }));
    return { error };
  }

  // Replace the optimistic local copy with the real DB row to prevent a duplicate
  // when the realtime echo arrives.
  if (data) {
    const idx = _chatMessages.findIndex(m => m.id === optimisticMsg.id);
    if (idx >= 0) _chatMessages[idx] = data;
  }
  return { error: null };
}

function markChatRead() {
  _chatUnreadCount = 0;
  _chatListeners.forEach(cb => cb({ type: 'read', unread: 0 }));
}

function onChatEvent(callback) {
  _chatListeners.add(callback);
  return () => _chatListeners.delete(callback);
}

// Expose chat for future UI to use
window.Chat = {
  send: sendChatMessage,
  markRead: markChatRead,
  subscribe: onChatEvent,
  messages: () => _chatMessages.slice(),
  unread: () => _chatUnreadCount,
};

// ── CHAT UI ───────────────────────────────────────────────────────────────────
function toggleChatPanel() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;
  if (panel.style.display === 'flex') {
    closeChatPanel();
  } else {
    openChatPanel();
  }
}

let _chatPanelUnsub = null;

function openChatPanel() {
  const panel = document.getElementById('chat-panel');
  const backdrop = document.getElementById('chat-backdrop');
  if (!panel || !backdrop) return;

  backdrop.style.display = 'block';
  panel.style.display = 'flex';
  // Force reflow then animate in
  requestAnimationFrame(() => {
    panel.style.transform = 'translateY(0)';
  });

  renderChatMessages();
  markChatRead();
  updateChatBadge();

  // Subscribe to chat events so the panel re-renders when new messages arrive
  if (_chatPanelUnsub) _chatPanelUnsub();
  _chatPanelUnsub = onChatEvent(evt => {
    renderChatMessages();
    if (evt.type === 'new') {
      // Mark read since we're viewing
      markChatRead();
      updateChatBadge();
      // Auto-scroll to bottom
      const list = document.getElementById('chat-messages');
      if (list) list.scrollTop = list.scrollHeight;
    }
  });

  // Scroll to bottom
  setTimeout(() => {
    const list = document.getElementById('chat-messages');
    if (list) list.scrollTop = list.scrollHeight;
    // Focus input on desktop, but not mobile (keyboard popup is jarring)
    if (window.matchMedia('(min-width: 640px)').matches) {
      const input = document.getElementById('chat-input');
      if (input) input.focus();
    }
  }, 260);
}

function closeChatPanel() {
  const panel = document.getElementById('chat-panel');
  const backdrop = document.getElementById('chat-backdrop');
  if (!panel || !backdrop) return;
  panel.style.transform = 'translateY(100%)';
  // Unsubscribe from chat events
  if (_chatPanelUnsub) { _chatPanelUnsub(); _chatPanelUnsub = null; }
  setTimeout(() => {
    panel.style.display = 'none';
    backdrop.style.display = 'none';
  }, 250);
}

function renderChatMessages() {
  const list = document.getElementById('chat-messages');
  if (!list) return;

  if (!_chatMessages.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-size:0.85rem;text-align:center;padding:30px 0">
      No messages yet. Start the conversation.
    </div>`;
    return;
  }

  list.innerHTML = _chatMessages.map(m => {
    const isMe = m.sender_id === me.id;
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const escapedText = escapeHtml(m.text);
    return `
      <div style="display:flex;gap:8px;align-items:flex-start;${isMe ? 'flex-direction:row-reverse' : ''}">
        <div style="flex-shrink:0;font-size:1.3rem;line-height:1">${m.sender_emoji || '🃏'}</div>
        <div style="max-width:75%;${isMe ? 'text-align:right' : ''}">
          <div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:3px">
            ${isMe ? 'You' : escapeHtml(m.sender_name || 'Player')} · ${time}
          </div>
          <div style="background:${isMe ? 'var(--gold-dim)' : 'var(--surface2)'};
            color:${isMe ? '#0d1a0d' : 'var(--text)'};
            padding:8px 12px;border-radius:14px;font-size:0.88rem;line-height:1.4;
            display:inline-block;word-wrap:break-word;text-align:left">
            ${escapedText}
          </div>
        </div>
      </div>`;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function sendChatFromInput() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const text = input.value;
  if (!text.trim()) return;

  input.value = ''; // clear immediately for snappy feel
  const { error } = await sendChatMessage(text);
  if (error) {
    input.value = text; // restore on failure
    toast(typeof error === 'string' ? error : 'Send failed');
  }
  // Scroll to bottom after send
  const list = document.getElementById('chat-messages');
  if (list) setTimeout(() => { list.scrollTop = list.scrollHeight; }, 100);
}

function updateChatBadge() {
  const badge = document.getElementById('chat-unread-badge');
  const lobbyBadge = document.getElementById('lobby-chat-unread-badge');
  const text = _chatUnreadCount > 9 ? '9+' : _chatUnreadCount;
  [badge, lobbyBadge].forEach(b => {
    if (!b) return;
    if (_chatUnreadCount > 0) {
      b.textContent = text;
      b.style.display = 'flex';
    } else {
      b.style.display = 'none';
    }
  });
}

