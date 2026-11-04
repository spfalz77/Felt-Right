// Capture console output from the very start, before any other script runs
window.__dbgLogs = [];
(function() {
  function pushLog(level, args) {
    try {
      const time = new Date().toLocaleTimeString();
      const text = Array.from(args).map(a => {
        if (a === null) return 'null';
        if (a === undefined) return 'undefined';
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message + '\n' + (a.stack||'');
        try { return JSON.stringify(a); } catch(e) { return String(a); }
      }).join(' ');
      window.__dbgLogs.push({ level, text: '[' + time + '] ' + (level === 'log' ? '' : level.toUpperCase() + ' ') + text });
      if (window.__dbgLogs.length > 1000) window.__dbgLogs.shift();
      // Update count badge live
      const cb = document.getElementById('dbg-count');
      if (cb) cb.textContent = window.__dbgLogs.length;
      // If the panel is open, append immediately
      if (window.__dbgPanelOpen && window.__dbgAppendLog) window.__dbgAppendLog(level, window.__dbgLogs[window.__dbgLogs.length-1].text);
    } catch(e) {}
  }
  ['log', 'warn', 'error', 'info', 'debug'].forEach(level => {
    const orig = console[level] ? console[level].bind(console) : function(){};
    console[level] = function() {
      pushLog(level, arguments);
      orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', function(e) {
    pushLog('error', ['UNCAUGHT: ' + e.message + ' at ' + (e.filename||'?') + ':' + (e.lineno||'?')]);
  });
  window.addEventListener('unhandledrejection', function(e) {
    pushLog('error', ['PROMISE: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)]);
  });
  console.log('debug console ready');
  console.log('user agent: ' + navigator.userAgent.slice(0, 80));
  // Quiet heartbeat (once per minute) so we know the page is alive
  setInterval(function() {
    console.log('heartbeat');
  }, 60000);
})();
