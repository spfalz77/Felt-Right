(function() {
  const logEl = document.getElementById('dbg-log');
  const panel = document.getElementById('dbg-panel');
  const toggle = document.getElementById('dbg-toggle');

  function colorFor(level) {
    return level === 'error' ? '#f55' : level === 'warn' ? '#fa0' : level === 'info' ? '#5af' : '#0f0';
  }

  function appendOne(level, text) {
    if (!logEl) return;
    const div = document.createElement('div');
    div.style.color = colorFor(level);
    div.style.borderBottom = '1px dotted #222';
    div.style.padding = '2px 0';
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // Expose so the head script can append in real time when panel is open
  window.__dbgAppendLog = appendOne;

  function renderAll() {
    logEl.innerHTML = '';
    (window.__dbgLogs || []).forEach(entry => appendOne(entry.level, entry.text));
  }

  toggle.onclick = () => {
    if (panel.style.display === 'flex') {
      panel.style.display = 'none';
      window.__dbgPanelOpen = false;
    } else {
      panel.style.display = 'flex';
      window.__dbgPanelOpen = true;
      renderAll();
    }
  };

  document.getElementById('dbg-close').onclick = () => {
    panel.style.display = 'none';
    window.__dbgPanelOpen = false;
  };
  document.getElementById('dbg-clear').onclick = () => {
    window.__dbgLogs.length = 0;
    if (logEl) logEl.innerHTML = '';
  };
  document.getElementById('dbg-copy').onclick = async () => {
    const text = (window.__dbgLogs || []).map(l => l.text).join('\n');
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      document.getElementById('dbg-copy').textContent = 'COPIED';
      setTimeout(() => { document.getElementById('dbg-copy').textContent = 'COPY'; }, 1200);
    } catch(e) {
      document.getElementById('dbg-copy').textContent = 'FAIL';
    }
  };

  console.log('debug panel ready, ' + (window.__dbgLogs?.length || 0) + ' logs buffered');

  // Hidden activation: tap top-left corner 5 times within 3 seconds to show the LOG button.
  // Once shown, persists via localStorage. Tap LOG button + hold 2s to hide again.
  let cornerTaps = 0;
  let cornerTapTimer = null;
  document.addEventListener('click', e => {
    if (e.clientX < 50 && e.clientY < 50) {
      cornerTaps++;
      clearTimeout(cornerTapTimer);
      cornerTapTimer = setTimeout(() => { cornerTaps = 0; }, 3000);
      if (cornerTaps >= 5) {
        cornerTaps = 0;
        try { localStorage.setItem('fr_debug_visible', '1'); } catch(e) {}
        toggle.style.display = 'flex';
      }
    }
  }, true);

  // Restore visibility from localStorage
  try {
    if (localStorage.getItem('fr_debug_visible') === '1') {
      toggle.style.display = 'flex';
    }
  } catch(e) {}

  // Long-press LOG button (2s) to hide it again
  let pressTimer = null;
  toggle.addEventListener('touchstart', () => {
    pressTimer = setTimeout(() => {
      try { localStorage.removeItem('fr_debug_visible'); } catch(e) {}
      toggle.style.display = 'none';
      panel.style.display = 'none';
      window.__dbgPanelOpen = false;
    }, 2000);
  });
  toggle.addEventListener('touchend', () => clearTimeout(pressTimer));
  toggle.addEventListener('touchmove', () => clearTimeout(pressTimer));
})();
