/* common.js — sesión, navegación, API REST y enlace MQTT sobre WebSockets */
(function () {
  'use strict';

  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function api(path, opts = {}) {
    const init = { credentials: 'same-origin', ...opts, headers: { ...(opts.headers || {}) } };
    if (init.body && !(init.body instanceof FormData) && typeof init.body !== 'string') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const res = await fetch(path, init);
    if (res.status === 401 && !path.startsWith('/api/auth/')) { location.href = '/login.html'; throw new Error('Sesión vencida'); }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
    return data;
  }

  function toast(message, type = 'info', ms = 3500) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  const fmtDate = ts => ts ? new Date(ts).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'medium' }) : '—';
  const fmtTime = ts => new Date(ts).toLocaleTimeString('es-MX');
  const fmtNum = (v, d = 1) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : '—';

  const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" fill="none" stroke="#2fd3b4" stroke-width="2"/><path d="M16 16 L27 9" stroke="#2fd3b4" stroke-width="2"/><circle cx="16" cy="16" r="7" fill="none" stroke="#2fd3b4" stroke-opacity=".45"/><circle cx="22" cy="12" r="2.2" fill="#f5a524"/></svg>`;

  const PAGES = [
    ['/index.html', 'Inicio'], ['/datos.html', 'Base de datos'],
    ['/monitoreo.html', 'Monitoreo'], ['/gestion.html', 'Gestión']
  ];

  function renderNav(active, user) {
    const nav = document.createElement('nav');
    nav.className = 'nav';
    nav.innerHTML = `
      <a class="brand" href="/index.html">${LOGO}<span>Estación Geoespacial</span></a>
      <div class="nav-links">${PAGES.map(([href, label]) =>
        `<a href="${href}" class="${href === active ? 'active' : ''}">${label}</a>`).join('')}</div>
      <div class="nav-right">
        <span class="badge" title="Conexión MQTT del navegador"><span class="dot" id="mqttDot"></span><span id="mqttLabel">MQTT</span></span>
        <span class="badge ${user.role === 'admin' ? 'admin' : ''}">${esc(user.name)} · ${user.role === 'admin' ? 'Administrador' : 'Usuario'}</span>
        <button class="btn sm" id="logoutBtn">Salir</button>
      </div>`;
    document.body.prepend(nav);
    nav.querySelector('#logoutBtn').onclick = async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      location.href = '/login.html';
    };
  }

  async function init(active) {
    const { user } = await api('/api/auth/me');
    renderNav(active, user);
    document.querySelectorAll('[data-admin]').forEach(el => el.classList.toggle('hidden', user.role !== 'admin'));
    App.user = user;
    return user;
  }

  /* ---------- Enlace MQTT sobre WebSockets ----------
   * Suscribe a la telemetría del rover (<base>/tx) y al planificador.
   * Los comandos se publican en <base>/web/cmd con un token; el backend valida el
   * rol y los reenvía al gateway, que los firma (HMAC) y los transmite por LoRa. */
  class RoverLink {
    constructor() { this.handlers = {}; this.pending = new Map(); this.client = null; this.cfg = null; }
    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }
    emit(event, arg) { (this.handlers[event] || []).forEach(fn => { try { fn(arg); } catch (e) { console.error(e); } }); }

    async connect() {
      this.cfg = await api('/api/config');
      if (typeof mqtt === 'undefined') { toast('No se cargó la biblioteca MQTT', 'error'); return this; }
      const m = this.cfg.mqtt;
      this.setStatus('warn', 'Conectando…');
      this.client = mqtt.connect(m.url, {
        username: m.username || undefined, password: m.password || undefined,
        clientId: `web-${this.cfg.deviceId}-${Math.random().toString(16).slice(2, 10)}`,
        reconnectPeriod: 4000, clean: true
      });
      this.client.on('connect', () => {
        this.setStatus('on', 'MQTT');
        this.client.subscribe([m.topics.rx, m.topics.webAck, m.topics.planner, m.topics.status]);
        this.emit('connect');
      });
      this.client.on('offline', () => this.setStatus('off', 'Sin MQTT'));
      this.client.on('reconnect', () => this.setStatus('warn', 'Reconectando…'));
      this.client.on('error', e => console.warn('MQTT', e.message));
      this.client.on('message', (topic, payload) => this.onMessage(topic, payload.toString()));
      return this;
    }

    setStatus(cls, label) {
      const dot = document.getElementById('mqttDot');
      const lab = document.getElementById('mqttLabel');
      if (dot) dot.className = `dot ${cls}`;
      if (lab) lab.textContent = label;
    }

    onMessage(topic, text) {
      const t = this.cfg.mqtt.topics;
      if (topic === t.rx) {
        const { lines, radio } = RoverLib.splitGatewayPayload(text);
        lines.forEach(line => {
          const parsed = RoverLib.parseRoverMessage(line);
          parsed.receivedAt = Date.now();
          if (radio) parsed.radio = radio;
          this.emit('rover', parsed);
        });
      } else if (topic === t.webAck) {
        let ack; try { ack = JSON.parse(text); } catch { return; }
        const p = this.pending.get(ack.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(ack.id); ack.ok ? p.resolve(ack) : p.reject(new Error(ack.error || 'Rechazado')); }
      } else if (topic === t.planner) {
        try { this.emit('planner', JSON.parse(text)); } catch { /* ignorar */ }
      } else if (topic === t.status) {
        this.emit('gateway', text);
      }
    }

    /** Publica un comando. Resuelve cuando el backend lo valida y lo entrega al gateway. */
    send(command, { quiet = false } = {}) {
      if (!this.client || !this.client.connected) {
        if (!quiet) toast('Sin conexión MQTT', 'error');
        return Promise.reject(new Error('Sin conexión MQTT'));
      }
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('El backend no confirmó el comando (¿está en ejecución?)')); }, 6000);
        this.pending.set(id, { resolve, reject, timer });
      });
      this.client.publish(this.cfg.mqtt.topics.webCmd, JSON.stringify({ id, command, token: this.cfg.commandToken }), { qos: 1 });
      this.emit('sent', command);
      if (!quiet) promise.catch(e => toast(`${command}: ${e.message}`, 'error'));
      return promise;
    }
  }

  /* ---------- Mapas (Leaflet) ---------- */
  function createMap(el, center = [19.2433, -103.7250], zoom = 17) {
    const map = L.map(el, { zoomControl: true }).setView(center, zoom);
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap'
    });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Imágenes &copy; Esri'
    });
    sat.addTo(map);
    L.control.layers({ 'Satélite': sat, 'Calles (OSM)': osm }, null, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    return map;
  }

  const roverIcon = () => L.divIcon({
    className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    html: '<div style="width:22px;height:22px;border-radius:50%;background:#2fd3b4;border:3px solid #062019;box-shadow:0 0 0 3px rgba(47,211,180,.35)"></div>'
  });
  const targetIcon = () => L.divIcon({
    className: '', iconSize: [26, 26], iconAnchor: [13, 13],
    html: '<div style="width:26px;height:26px;border-radius:50%;border:3px solid #f5a524;background:rgba(245,165,36,.25);display:grid;place-items:center"><div style="width:6px;height:6px;border-radius:50%;background:#f5a524"></div></div>'
  });

  /* ---------- Gráficas (Chart.js) ---------- */
  function lineChart(canvas, datasets, { xIsTime = true, yTitle = '', y2Title = '' } = {}) {
    Chart.defaults.color = '#8ea2b5';
    Chart.defaults.borderColor = 'rgba(142,162,181,.12)';
    Chart.defaults.font.family = '"IBM Plex Sans", system-ui, sans-serif';
    const scales = {
      x: {
        type: 'linear',
        ticks: { maxTicksLimit: 7, callback: v => xIsTime ? new Date(v).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : v }
      },
      y: { title: { display: !!yTitle, text: yTitle } }
    };
    if (y2Title) scales.y2 = { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: y2Title } };
    return new Chart(canvas, {
      type: 'line',
      data: { datasets: datasets.map(d => ({ pointRadius: 0, borderWidth: 2, tension: .2, spanGaps: false, ...d })) },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: {
          legend: { labels: { boxWidth: 12, usePointStyle: true } },
          tooltip: { callbacks: { title: items => items.length ? (xIsTime ? new Date(items[0].parsed.x).toLocaleString('es-MX') : `${items[0].parsed.x}`) : '' } }
        },
        scales
      }
    });
  }

  function downloadText(filename, text, type = 'text/plain') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.App = { api, toast, esc, fmtDate, fmtTime, fmtNum, init, RoverLink, createMap, roverIcon, targetIcon, lineChart, downloadText, user: null };
})();
