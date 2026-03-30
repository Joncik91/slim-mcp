// Inline HTML dashboard for slim-mcp
export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>slim-mcp dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', monospace; background: #0d1117; color: #c9d1d9; font-size: 14px; padding: 20px; }
  h1 { font-size: 18px; color: #58a6ff; margin-bottom: 4px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #21262d; padding-bottom: 12px; }
  .uptime { color: #8b949e; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 14px; text-align: center; }
  .card .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card .value { font-size: 24px; font-weight: bold; color: #58a6ff; }
  .card .value.green { color: #3fb950; }
  .card .value.yellow { color: #d29922; }
  .section { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .section h2 { font-size: 13px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
  .bar-container { background: #21262d; border-radius: 4px; height: 8px; margin: 8px 0; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .bar-fill.blue { background: #58a6ff; }
  .bar-fill.green { background: #3fb950; }
  .stat-row { display: flex; justify-content: space-between; margin: 4px 0; font-size: 13px; }
  .stat-row .label { color: #8b949e; }
  .server-list { list-style: none; }
  .server-list li { padding: 6px 0; border-bottom: 1px solid #21262d; font-size: 13px; }
  .server-list li:last-child { border-bottom: none; }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .status-dot.ok { background: #3fb950; }
  .status-dot.fail { background: #f85149; }
  .calls-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .calls-table th { text-align: left; color: #8b949e; font-weight: normal; padding: 4px 8px; border-bottom: 1px solid #21262d; }
  .calls-table td { padding: 4px 8px; border-bottom: 1px solid #21262d; }
  .hit { color: #3fb950; }
  .miss { color: #d29922; }
  .promoted { color: #bc8cff; }
  .time { color: #8b949e; }
  .calls-container { max-height: 300px; overflow-y: auto; }
  .no-data { color: #484f58; font-style: italic; font-size: 13px; }
  @media (max-width: 600px) { .cards { grid-template-columns: repeat(2, 1fr); } body { padding: 12px; } }
</style>
</head>
<body>
<div class="header">
  <div><h1>slim-mcp</h1><span class="uptime" id="uptime">starting...</span></div>
  <div class="uptime" id="connection-status">connecting...</div>
</div>

<div class="cards">
  <div class="card"><div class="label">Tokens Saved</div><div class="value green" id="tokens-saved">0</div></div>
  <div class="card"><div class="label">Cache Hit %</div><div class="value" id="cache-rate">0%</div></div>
  <div class="card"><div class="label">Tools</div><div class="value" id="tool-count">0</div></div>
  <div class="card"><div class="label">Calls</div><div class="value" id="call-count">0</div></div>
</div>

<div class="section" id="servers-section">
  <h2>Servers</h2>
  <ul class="server-list" id="server-list"><li class="no-data">waiting for data...</li></ul>
</div>

<div class="section">
  <h2>Compression</h2>
  <div class="stat-row"><span class="label">Level</span><span id="comp-level">—</span></div>
  <div class="stat-row"><span class="label">Original</span><span id="comp-original">—</span></div>
  <div class="stat-row"><span class="label">Compressed</span><span id="comp-compressed">—</span></div>
  <div class="stat-row"><span class="label">Saved</span><span id="comp-saved">—</span></div>
  <div class="bar-container"><div class="bar-fill blue" id="comp-bar" style="width:0"></div></div>
</div>

<div class="section" id="lazy-section" style="display:none">
  <h2>Lazy Loading</h2>
  <div class="stat-row"><span class="label">Full schemas</span><span id="lazy-full">0</span></div>
  <div class="stat-row"><span class="label">Slim indexes</span><span id="lazy-slim">0</span></div>
  <div class="stat-row"><span class="label">Tokens saved</span><span id="lazy-saved">0</span></div>
  <div class="stat-row"><span class="label">Promotions</span><span id="lazy-promotions">0</span></div>
  <div class="bar-container"><div class="bar-fill blue" id="lazy-bar" style="width:0"></div></div>
</div>

<div class="section">
  <h2>Cache</h2>
  <div class="stat-row"><span class="label">Hits</span><span class="hit" id="cache-hits">0</span></div>
  <div class="stat-row"><span class="label">Misses</span><span id="cache-misses">0</span></div>
  <div class="stat-row"><span class="label">Skips</span><span id="cache-skips">0</span></div>
  <div class="stat-row"><span class="label">Tokens saved</span><span id="cache-tokens">0</span></div>
  <div class="bar-container"><div class="bar-fill green" id="cache-bar" style="width:0"></div></div>
</div>

<div class="section">
  <h2>Recent Tool Calls</h2>
  <div class="calls-container">
    <table class="calls-table">
      <thead><tr><th>Time</th><th>Tool</th><th>Status</th><th>Duration</th></tr></thead>
      <tbody id="calls-body"><tr><td colspan="4" class="no-data">no calls yet</td></tr></tbody>
    </table>
  </div>
</div>

<script>
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.textContent; }
function fmt(n) { return n.toLocaleString('en-US'); }
function fmtUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60);
  return h + 'h ' + m + 'm';
}
function timeStr(iso) {
  try { return new Date(iso).toLocaleTimeString('en-GB', { hour12: false }); } catch { return ''; }
}

function setText(id, text) { document.getElementById(id).textContent = text; }

function update(data) {
  setText('uptime', 'uptime: ' + fmtUptime(data.uptime));
  setText('tokens-saved', fmt(data.totalSavedTokens));
  setText('cache-rate', data.cache.hitRate + '%');
  const rateEl = document.getElementById('cache-rate');
  rateEl.className = 'value ' + (data.cache.hitRate >= 50 ? 'green' : data.cache.hitRate > 0 ? 'yellow' : '');

  const totalTools = data.servers.reduce(function(s, srv) { return s + srv.tools; }, 0);
  setText('tool-count', String(totalTools));
  setText('call-count', fmt(data.toolCalls.total));

  // Servers — build safely with DOM
  const sl = document.getElementById('server-list');
  sl.replaceChildren();
  if (data.servers.length > 0) {
    data.servers.forEach(function(s) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'status-dot ' + (s.status === 'connected' ? 'ok' : 'fail');
      li.appendChild(dot);
      li.appendChild(document.createTextNode(s.name + ' (' + s.transport + ') \\u2014 ' + s.tools + ' tools'));
      sl.appendChild(li);
    });
  } else {
    const li = document.createElement('li');
    li.className = 'no-data';
    li.textContent = 'no servers connected';
    sl.appendChild(li);
  }

  // Compression
  setText('comp-level', data.compression.level);
  setText('comp-original', fmt(data.compression.originalTokens) + ' tokens');
  setText('comp-compressed', fmt(data.compression.compressedTokens) + ' tokens');
  setText('comp-saved', fmt(data.compression.savedTokens) + ' tokens (' + data.compression.reductionPercent + '%)');
  document.getElementById('comp-bar').style.width = Math.min(data.compression.reductionPercent, 100) + '%';

  // Lazy
  if (data.lazy.enabled) {
    document.getElementById('lazy-section').style.display = 'block';
    setText('lazy-full', String(data.lazy.fullTools));
    setText('lazy-slim', String(data.lazy.slimTools));
    setText('lazy-saved', fmt(data.lazy.savedTokens));
    setText('lazy-promotions', String(data.lazy.promotions.length));
    document.getElementById('lazy-bar').style.width = Math.min(data.lazy.reductionPercent, 100) + '%';
  }

  // Cache
  setText('cache-hits', fmt(data.cache.hits));
  setText('cache-misses', fmt(data.cache.misses));
  setText('cache-skips', fmt(data.cache.skips));
  setText('cache-tokens', '~' + fmt(data.cache.estimatedTokensSaved));
  document.getElementById('cache-bar').style.width = Math.min(data.cache.hitRate, 100) + '%';

  // Recent calls — build safely with DOM
  var tbody = document.getElementById('calls-body');
  var calls = data.toolCalls.recent.slice().reverse().slice(0, 30);
  if (calls.length > 0) {
    tbody.replaceChildren();
    calls.forEach(function(c) {
      var tr = document.createElement('tr');
      var tdTime = document.createElement('td'); tdTime.className = 'time'; tdTime.textContent = timeStr(c.timestamp);
      var tdTool = document.createElement('td'); tdTool.textContent = c.tool;
      var tdStatus = document.createElement('td');
      var statusSpan = document.createElement('span');
      if (c.promoted) { statusSpan.className = 'promoted'; statusSpan.textContent = 'PROMOTED'; }
      else if (c.cached) { statusSpan.className = 'hit'; statusSpan.textContent = 'HIT'; }
      else { statusSpan.className = 'miss'; statusSpan.textContent = 'MISS'; }
      tdStatus.appendChild(statusSpan);
      var tdDur = document.createElement('td'); tdDur.className = 'time'; tdDur.textContent = c.durationMs + 'ms';
      tr.appendChild(tdTime); tr.appendChild(tdTool); tr.appendChild(tdStatus); tr.appendChild(tdDur);
      tbody.appendChild(tr);
    });
  }
}

// SSE connection
function connect() {
  var status = document.getElementById('connection-status');
  var es = new EventSource('/api/events');
  es.addEventListener('stats_update', function(e) {
    try { update(JSON.parse(e.data)); status.textContent = 'live'; status.style.color = '#3fb950'; } catch(err) {}
  });
  es.onerror = function() { status.textContent = 'reconnecting...'; status.style.color = '#d29922'; };
}

// Initial fetch + SSE
fetch('/api/stats').then(function(r) { return r.json(); }).then(update).catch(function() {});
connect();
</script>
</body>
</html>`;
}
