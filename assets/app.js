(() => {
  'use strict';

  // ======= Stałe & stan =======
  const PASSWORD = 'MCPMDR';
  const RX = { lat: 54.546, lon: 18.5501 }; // Gdynia Oksywie
  const ACTIVE_TIMEOUT_SEC = 900;   // 15 min bez nowych danych → "zakończona"
  const VISIBILITY_WINDOW_SEC = 3600; // 1 h po zakończeniu → ukryj
  const HISTORY_LIMIT = 600;        // ok. 50 min przy 5 s

  const state = {
    source: 'radiosondy',   // 'ttgo' | 'radiosondy'
    filterId: '',
    fetchTimer: null,
    map: null,
    layers: {},
    rxMarker: null,
    sondes: new Map(),      // id -> sonde object
    activeId: null,
    charts: {},
    lang: localStorage.getItem('lang') || 'pl'
  };

  // ======= i18n (zostawiamy jak było) =======
  const translations = {
    pl: {
      login_title: 'SYSTEM TELEMETRII RADIOSOND METEOROLOGICZNYCH',
      brand_sub: 'Dostęp chroniony hasłem',
      login_password_label: 'Hasło',
      login_button: 'Zaloguj',
      source_ttgo: 'TTGO',
      source_radiosondy: 'radiosondy.info',
      ttgo_url_label: 'URL TTGO',
      sonde_id_label: 'ID sondy',
      btn_search: 'Szukaj',
      btn_show_all: 'Wszystkie',
      charts_title: 'Dane graficzne',
      status_active: 'Aktywna',
      status_ended: 'Radiosondaż zakończył się'
    },
    en: {
      login_title: 'METEOROLOGICAL RADIOSONDE TELEMETRY SYSTEM',
      brand_sub: 'Password protected access',
      login_password_label: 'Password',
      login_button: 'Log in',
      source_ttgo: 'TTGO',
      source_radiosondy: 'radiosondy.info',
      ttgo_url_label: 'TTGO URL',
      sonde_id_label: 'Sonde ID',
      btn_search: 'Search',
      btn_show_all: 'All',
      charts_title: 'Charts',
      status_active: 'Active',
      status_ended: 'Sounding finished'
    }
  };

  function applyTranslations() {
    const t = translations[state.lang] || translations.pl;
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      if (t[k]) el.textContent = t[k];
    });
  }

  // ======= Helpery =======
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const fmt = (v, d = 0) => Number.isFinite(v) ? v.toFixed(d) : '—';

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const toRad = x => x * Math.PI / 180;
    const toDeg = x => x * 180 / Math.PI;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    let brng = toDeg(Math.atan2(y, x));
    return (brng + 360) % 360;
  }

  function dewPoint(T, RH) {
    if (!Number.isFinite(T) || !Number.isFinite(RH)) return null;
    const a = 17.27, b = 237.7;
    const alpha = (a * T) / (b + T) + Math.log(clamp(RH, 0, 100) / 100);
    return (b * alpha) / (a - alpha);
  }

  function thetaK(Tc, p) {
    if (!Number.isFinite(Tc) || !Number.isFinite(p) || p <= 0) return null;
    const Tk = Tc + 273.15;
    return Tk * Math.pow(1000 / p, 0.2854);
  }

  function lclHeight(Tc, Td) {
    if (!Number.isFinite(Tc) || !Number.isFinite(Td)) return null;
    if (Tc < Td) return null;
    return 125 * (Tc - Td);
  }

  function zeroIsoHeight(history) {
    const arr = [...history].sort((a, b) => a.alt - b.alt);
    for (let i = 1; i < arr.length; i++) {
      const t1 = arr[i - 1].temp;
      const t2 = arr[i].temp;
      if (!Number.isFinite(t1) || !Number.isFinite(t2)) continue;
      if ((t1 <= 0 && t2 >= 0) || (t1 >= 0 && t2 <= 0)) {
        const z1 = arr[i - 1].alt;
        const z2 = arr[i].alt;
        const k = (0 - t1) / (t2 - t1);
        return z1 + k * (z2 - z1);
      }
    }
    return null;
  }

  // ======= Login (bez zmian logiki) =======
  function initLogin() {
    const overlay = $('#login-overlay');
    if (sessionStorage.getItem('mcpmdr_logged_in') === 'true') {
      overlay.classList.remove('show');
      $('#app').classList.remove('hidden');
      return;
    }
    overlay.classList.add('show');
    $('#password').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('#login-btn').click();
    });
    $('#login-btn').addEventListener('click', () => {
      const pass = $('#password').value || '';
      if (pass === PASSWORD) {
        sessionStorage.setItem('mcpmdr_logged_in', 'true');
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 250);
        $('#app').classList.remove('hidden');
      } else {
        $('#login-error').textContent = 'Błędne hasło';
      }
    });
  }

  // ======= Mapa =======
  function initMap() {
    const map = L.map('map', { zoomControl: true });
    state.map = map;

    const tileOpts = {
      attribution: '© OSM contributors',
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: 3
    };

    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', tileOpts);
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      ...tileOpts,
      attribution: '© OpenTopoMap'
    });
    const esri = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        ...tileOpts,
        attribution: '© Esri'
      }
    );

    state.layers = { osm, topo, esri };
    osm.addTo(map);
    L.control.layers(
      {
        'OpenStreetMap': osm,
        'OpenTopoMap': topo,
        'Esri World Imagery': esri
      },
      {},
      { position: 'topleft' }
    ).addTo(map);

    map.setView([RX.lat, RX.lon], 10);

    state.rxMarker = L.marker([RX.lat, RX.lon], {
      title: 'RX',
      icon: L.divIcon({
        className: 'rx-icon',
        html: '<div style="width:16px;height:16px;border-radius:50%;background:linear-gradient(180deg,#7bffb0,#3dd4ff);border:2px solid #0b1020"></div>'
      })
    }).addTo(map);
    state.rxMarker.bindTooltip('RX Gdynia Oksywie', {
      permanent: true,
      direction: 'right',
      offset: [10, 0]
    });

    const kick = () => { map.invalidateSize(false); };
    requestAnimationFrame(kick);
    setTimeout(kick, 250);
    setTimeout(kick, 1000);
    window.addEventListener('resize', () => setTimeout(kick, 120));
  }

  // ======= UI =======
  function initUI() {
    applyTranslations();

    // Język
    $$('.lang .btn').forEach(b => {
      b.addEventListener('click', () => {
        state.lang = b.dataset.lang;
        localStorage.setItem('lang', state.lang);
        applyTranslations();
      });
    });

    // Zakładki widoków
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const view = tab.dataset.view;
        if (view === 'telemetry') {
          $('#view-telemetry').classList.add('show');
          $('#view-charts').classList.remove('show');
          setTimeout(() => state.map && state.map.invalidateSize(), 120);
        } else {
          $('#view-telemetry').classList.remove('show');
          $('#view-charts').classList.add('show');
          setTimeout(resizeCharts, 100);
        }
      });
    });

    // Źródło danych
    const segTTGO = $('#seg-ttgo');
    const segR = $('#seg-radiosondy');
    function setSourceSegment(activeBtn) {
      [segTTGO, segR].forEach(b => b.classList.toggle('active', b === activeBtn));
      state.source = activeBtn.dataset.src;
      $('#ttgo-url-wrap').classList.toggle('hidden', state.source !== 'ttgo');
      $('#radiosondy-search').classList.toggle('hidden', state.source !== 'radiosondy');
      restartFetching();
    }
    segTTGO.addEventListener('click', () => setSourceSegment(segTTGO));
    segR.addEventListener('click', () => setSourceSegment(segR));

    // Szukaj / wszystkie (radiosondy.info)
    $('#btn-search').addEventListener('click', () => {
      state.filterId = ($('#sonde-id').value || '').trim();
      restartFetching();
    });
    $('#btn-show-all').addEventListener('click', () => {
      state.filterId = '';
      $('#sonde-id').value = '';
      restartFetching();
    });

    // Fullscreen wykresów
    $$('.fullscreen-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.card');
        card.classList.toggle('fullscreen');
        setTimeout(resizeCharts, 60);
      });
    });

    // Początkowy widok
    $('#view-telemetry').classList.add('show');
  }

  // ======= Harmonogram pobierania =======
  function restartFetching() {
    if (state.fetchTimer) {
      clearInterval(state.fetchTimer);
      state.fetchTimer = null;
    }
    fetchOnce();
    state.fetchTimer = setInterval(fetchOnce, 5000);
  }

  async function fetchOnce() {
    if (state.source === 'radiosondy') {
      await fetchRadiosondy();
    } else {
      await fetchTTGO();
    }
    render();
  }

  // ======= TTGO (na razie szkielet) =======
  async function fetchTTGO() {
    const url = ($('#ttgo-url').value || '').trim() || 'http://192.168.0.50/sondes.json';
    if (location.protocol === 'https:' && url.startsWith('http:')) {
      $('#status-line').textContent =
        'HTTPS strony + HTTP TTGO = mixed content (uruchom lokalnie po HTTP / użyj tunelu HTTPS).';
      return;
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      // TODO: gdy będziemy znać format TTGO, zmapujemy go na model sondy
      $('#status-line').textContent =
        'TTGO: odebrano dane (' + (Array.isArray(data) ? data.length : 1) + ')';
    } catch (e) {
      $('#status-line').textContent = 'TTGO: błąd pobierania: ' + e.message;
    }
  }

  // ======= radiosondy.info przez /api/radiosondy =======
  async function fetchRadiosondy() {
    const q = state.filterId
      ? `/api/radiosondy?mode=single&id=${encodeURIComponent(state.filterId)}`
      : '/api/radiosondy?mode=all';

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(q, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(t);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const csv = await res.text();
        parseAndMergeCSV(csv);

        // nowy status: pokazuje liczbę sond z danymi
        const visibleCount = [...state.sondes.values()].filter(s => s.time).length;
        $('#status-line').textContent =
          `radiosondy.info: OK (próba ${attempt}, sondy: ${visibleCount})`;
        return;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 1200 * attempt));
      }
    }
    const msg = (lastErr && lastErr.name === 'AbortError')
      ? '(Przekroczony czas odpowiedzi radiosondy.info)'
      : String(lastErr);
    $('#status-line').textContent = `Błąd pobierania danych. ${msg}`;
  }

  // ======= CSV parsing =======
  function parseAndMergeCSV(csv) {
    if (!csv) return;
    const lines = csv.split(/\r?\n/).filter(l => l.trim().length);
    if (lines.length < 2) return;

    const sep = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(sep).map(h => h.trim().toLowerCase());

    function colIdx(names) {
      for (const name of names) {
        const i = headers.findIndex(h => h === name.toLowerCase());
        if (i !== -1) return i;
      }
      for (const name of names) {
        const i = headers.findIndex(h => h.includes(name.toLowerCase()));
        if (i !== -1) return i;
      }
      return -1;
    }

    const idx = {
      id: colIdx(['sonde', 'id', 'serial']),
      type: colIdx(['type', 'model']),
      lat: colIdx(['latitude', 'lat']),
      lon: colIdx(['longitude', 'lon', 'lng']),
      alt: colIdx(['altitude', 'alt']),
      temp: colIdx(['temp', 'temperature']),
      pressure: colIdx(['pres', 'pressure', 'p']),
      humidity: colIdx(['humi', 'rh']),
      windSpeed: colIdx(['speed', 'ws']),
      windDir: colIdx(['course', 'wd']),
      rssi: colIdx(['rssi']),
      time: colIdx(['datetime', 'time', 'timestamp'])
    };

    // UWAGA: nie obcinamy tu danych starszych niż 1h – tylko odrzucamy rekordy bez poprawnego czasu.
    for (let li = 1; li < lines.length; li++) {
      const row = lines[li].split(sep);
      const rec = i => {
        if (i < 0) return '';
        const v = row[i];
        return v == null ? '' : String(v).trim();
      };

      const tRaw = rec(idx.time);
      let tms = NaN;
      if (/^[0-9]+$/.test(tRaw)) {
        const n = parseInt(tRaw, 10);
        tms = (tRaw.length < 11) ? n * 1000 : n;
      } else {
        tms = Date.parse(tRaw);
      }
      if (!Number.isFinite(tms)) continue;

      const lat = parseFloat(rec(idx.lat));
      const lon = parseFloat(rec(idx.lon));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const id = rec(idx.id) || 'UNKNOWN';
      if (state.filterId &&
        !id.toLowerCase().includes(state.filterId.toLowerCase())) continue;

      const s = getOrCreateSonde(id);
      const point = {
        time: new Date(tms),
        lat,
        lon,
        alt: toNum(rec(idx.alt)),
        temp: toNum(rec(idx.temp)),
        pressure: toNum(rec(idx.pressure)),
        humidity: toNum(rec(idx.humidity))
      };

      mergePoint(s, point, {
        type: rec(idx.type),
        windSpeed: toNum(rec(idx.windSpeed)),
        windDir: toNum(rec(idx.windDir)),
        rssi: toNum(rec(idx.rssi))
      });
    }

    // usuwanie sond >1h po zakończeniu – pozostaje
    const now = Date.now();
    for (const [id, s] of state.sondes) {
      if (!s.time) continue;
      const ageSec = (now - s.time) / 1000;
      if (s.status === 'finished' && ageSec > VISIBILITY_WINDOW_SEC) {
        removeSonde(id);
      }
    }
  }

  function toNum(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  function getOrCreateSonde(id) {
    if (!state.sondes.has(id)) {
      state.sondes.set(id, {
        id,
        type: null,
        lat: null,
        lon: null,
        alt: null,
        temp: null,
        pressure: null,
        humidity: null,
        windSpeed: null,
        windDir: null,
        rssi: null,
        time: null,
        dewPoint: null,
        horizontalSpeed: null,
        horizontalCourse: null,
        verticalSpeed: null,
        speed3d: null,
        distanceToRx: null,
        theta: null,
        lclHeight: null,
        zeroIsoHeight: null,
        ageSec: null,
        status: 'active',
        history: [],
        marker: null,
        polyline: null
      });
    }
    return state.sondes.get(id);
  }

  function mergePoint(s, p, extra) {
    s.type = extra.type || s.type;

    if (!s.time || p.time > s.time) {
      s.history.push({
        time: p.time,
        lat: p.lat,
        lon: p.lon,
        alt: p.alt,
        temp: p.temp,
        pressure: p.pressure,
        humidity: p.humidity
      });
      if (s.history.length > HISTORY_LIMIT) {
        s.history.splice(0, s.history.length - HISTORY_LIMIT);
      }
    }

    Object.assign(s, p, {
      windSpeed: extra.windSpeed,
      windDir: extra.windDir,
      rssi: extra.rssi
    });

    s.ageSec = (Date.now() - s.time) / 1000;
    s.status = (s.ageSec > ACTIVE_TIMEOUT_SEC) ? 'finished' : 'active';

    s.dewPoint = dewPoint(s.temp, s.humidity);
    s.theta = thetaK(s.temp, s.pressure);
    s.lclHeight = lclHeight(s.temp, s.dewPoint);
    s.zeroIsoHeight = zeroIsoHeight(s.history);
    s.distanceToRx =
      (Number.isFinite(s.lat) && Number.isFinite(s.lon))
        ? haversine(RX.lat, RX.lon, s.lat, s.lon)
        : null;

    const n = s.history.length;
    if (n >= 2) {
      const a = s.history[n - 2];
      const b = s.history[n - 1];
      const dt = clamp((b.time - a.time) / 1000, 0.5, 600);
      const dH = haversine(a.lat, a.lon, b.lat, b.lon);
      s.horizontalSpeed = dH / dt;
      s.verticalSpeed =
        (Number.isFinite(a.alt) && Number.isFinite(b.alt))
          ? (b.alt - a.alt) / dt
          : null;
      s.speed3d =
        (Number.isFinite(s.verticalSpeed) && Number.isFinite(s.horizontalSpeed))
          ? Math.sqrt(dH * dH + (b.alt - a.alt) ** 2) / dt
          : null;
      s.horizontalCourse = bearing(a.lat, a.lon, b.lat, b.lon);
    }

    ensureMapObjects(s);
  }

  function ensureMapObjects(s) {
    if (!state.map) return;

    if (!s.marker) {
      s.marker = L.circleMarker([s.lat, s.lon], {
        radius: 6,
        color: '#3dd4ff',
        fillColor: '#3dd4ff',
        fillOpacity: 0.9
      });
      s.marker.on('click', () => setActiveSonde(s.id, true));
      s.marker.addTo(state.map);
    } else {
      s.marker.setLatLng([s.lat, s.lon]);
    }

    if (!s.polyline) {
      s.polyline = L.polyline(
        s.history.map(h => [h.lat, h.lon]),
        { color: 'rgba(61,212,255,0.45)', weight: 2 }
      );
      s.polyline.addTo(state.map);
    } else {
      s.polyline.setLatLngs(s.history.map(h => [h.lat, h.lon]));
    }

    const label = `${s.type ? (s.type + ' ') : ''}${s.id}`;
    s.marker.bindTooltip(label, { direction: 'top', offset: [0, -8] });
  }

  function removeSonde(id) {
    const s = state.sondes.get(id);
    if (!s) return;
    if (s.marker) s.marker.remove();
    if (s.polyline) s.polyline.remove();
    state.sondes.delete(id);
    if (state.activeId === id) state.activeId = null;
  }

  // ======= Renderowanie UI =======
  function render() {
    renderTabs();
    renderPanel();
    renderCharts();
  }

  function renderTabs() {
    const wrap = $('#sonde-tabs');
    wrap.innerHTML = '';
    const list = [...state.sondes.values()];
    list.sort((a, b) => (b.time || 0) - (a.time || 0));

    for (const s of list) {
      const btn = document.createElement('button');
      btn.className = 'sonde-tab' + (s.id === state.activeId ? ' active' : '');
      btn.textContent = `${s.type ? (s.type + ' ') : ''}${s.id}`;
      btn.addEventListener('click', () => setActiveSonde(s.id, true));
      wrap.appendChild(btn);
    }

    if (!state.activeId && list.length) {
      setActiveSonde(list[0].id, false);
    }
  }

  function setActiveSonde(id, center) {
    state.activeId = id;
    renderTabs();
    renderPanel();
    if (center) {
      const s = state.sondes.get(id);
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
        state.map.setView([s.lat, s.lon], Math.max(10, state.map.getZoom()));
      }
    }
  }

  function renderPanel() {
    const s = state.sondes.get(state.activeId);
    const panel = $('#sonde-panel');
    if (!s) {
      panel.innerHTML = '';
      return;
    }

    const t = translations[state.lang] || translations.pl;
    const timeStr = s.time ? new Date(s.time).toLocaleString() : '—';
    const statusStr = s.status === 'active'
      ? t.status_active
      : t.status_ended;

    const items = [
      { label: 'Wysokość [m]', value: fmt(s.alt, 0) },
      { label: 'Temperatura [°C]', value: fmt(s.temp, 1) },
      { label: 'Punkt rosy [°C]', value: fmt(s.dewPoint, 1) },
      { label: 'Ciśnienie [hPa]', value: fmt(s.pressure, 1) },
      { label: 'Wilgotność [%]', value: fmt(s.humidity, 0) },
      { label: 'Prędkość pionowa [m/s]', value: fmt(s.verticalSpeed, 1) },
      { label: 'Prędkość pozioma [m/s]', value: fmt(s.horizontalSpeed, 1) },
      { label: 'Kurs [°]', value: fmt(s.horizontalCourse, 0) },
      { label: 'Odległość od RX [m]', value: fmt(s.distanceToRx, 0) },
      { label: '0 °C izoterma [m]', value: fmt(s.zeroIsoHeight, 0) },
      { label: 'LCL [m]', value: fmt(s.lclHeight, 0) },
      { label: 'θ [K]', value: fmt(s.theta, 1) }
      // wskaźnik stabilności dodamy w finalnej wersji
    ];

    panel.innerHTML = `
      <div class="card" style="grid-column:1/-1">
        <div class="label">${s.type || ''}</div>
        <div class="value" style="font-weight:700;font-size:20px">${s.id}</div>
        <div class="sub">${timeStr} — ${statusStr}</div>
      </div>
      ${items.map(i => `
        <div class="card">
          <div class="label">${i.label}</div>
          <div class="value">${i.value}</div>
        </div>
      `).join('')}
    `;

    $$('.sonde-tab').forEach(el => {
      el.classList.toggle('active', el.textContent.endsWith(s.id));
    });
  }

  // ======= Wykresy – grafanowy styl (czas na X) =======
  function ensureChart(id, builder) {
    if (state.charts[id]) return state.charts[id];
    const ctx = document.getElementById(id);
    const cfg = builder(ctx);
    const chart = new Chart(ctx, cfg);
    state.charts[id] = chart;
    return chart;
  }

  function timeScaleOptions(label) {
    return {
      type: 'linear',
      title: { display: !!label, text: label, color: '#e6ebff' },
      grid: { color: 'rgba(134,144,176,.35)' },
      ticks: {
        color: '#e6ebff',
        callback: v => new Date(v).toLocaleTimeString()
      }
    };
  }

  function commonY(label) {
    return {
      title: { display: !!label, text: label, color: '#e6ebff' },
      grid: { color: 'rgba(134,144,176,.35)' },
      ticks: { color: '#e6ebff' }
    };
  }

  function resizeCharts() {
    Object.values(state.charts).forEach(c => c.resize());
  }

  function renderCharts() {
    const s = state.sondes.get(state.activeId);
    const hist = s ? s.history.slice().sort((a, b) => a.time - b.time) : [];

    // 1) Voltages vs Temperature – na razie tylko T (brak napięcia z radiosondy)
    (function () {
      const id = 'chart-volt-temp';
      const chart = ensureChart(id, () => ({
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Temperatura [°C]',
              data: [],
              yAxisID: 'yTemp',
              borderWidth: 1.5,
              pointRadius: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: timeScaleOptions('Czas'),
            yTemp: commonY('Temperatura [°C]')
          },
          plugins: { legend: { labels: { color: '#e6ebff' } } }
        }
      }));

      const tempData = hist
        .filter(h => Number.isFinite(h.temp))
        .map(h => ({ x: h.time.getTime(), y: h.temp }));

      chart.data.datasets[0].data = tempData;
      chart.update('none');
    })();

    // 2) GNSS Satellites in Use – placeholder (TTGO, na razie puste)
    (function () {
      const id = 'chart-gnss';
      const chart = ensureChart(id, () => ({
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Satellites in use',
              data: [],
              borderWidth: 1.5,
              pointRadius: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: timeScaleOptions('Czas'),
            y: commonY('Liczba satelitów')
          },
          plugins: { legend: { labels: { color: '#e6ebff' } } }
        }
      }));

      chart.data.datasets[0].data = []; // TTGO w przyszłości
      chart.update('none');
    })();

    // 3) Payload Environmental Sensor Data – T / RH / p
    (function () {
      const id = 'chart-env';
      const chart = ensureChart(id, () => ({
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Temperatura [°C]',
              yAxisID: 'yTemp',
              data: [],
              borderWidth: 1.2,
              pointRadius: 0
            },
            {
              label: 'Wilgotność [%]',
              yAxisID: 'yRH',
              data: [],
              borderWidth: 1.2,
              pointRadius: 0
            },
            {
              label: 'Ciśnienie [hPa]',
              yAxisID: 'yP',
              data: [],
              borderWidth: 1.2,
              pointRadius: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: timeScaleOptions('Czas'),
            yTemp: commonY('T [°C]'),
            yRH: { ...commonY('RH [%]'), position: 'right' },
            yP: { ...commonY('p [hPa]'), position: 'right' }
          },
          plugins: { legend: { labels: { color: '#e6ebff' } } }
        }
      }));

      const tempData = hist
        .filter(h => Number.isFinite(h.temp))
        .map(h => ({ x: h.time.getTime(), y: h.temp }));
      const rhData = hist
        .filter(h => Number.isFinite(h.humidity))
        .map(h => ({ x: h.time.getTime(), y: h.humidity }));
      const pData = hist
        .filter(h => Number.isFinite(h.pressure))
        .map(h => ({ x: h.time.getTime(), y: h.pressure }));

      chart.data.datasets[0].data = tempData;
      chart.data.datasets[1].data = rhData;
      chart.data.datasets[2].data = pData;
      chart.update('none');
    })();

    // 4) Horizontal Velocity – z historii sondy
    (function () {
      const id = 'chart-hvel';
      const chart = ensureChart(id, () => ({
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Prędkość pozioma [m/s]',
              data: [],
              borderWidth: 1.5,
              pointRadius: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: timeScaleOptions('Czas'),
            y: commonY('v_h [m/s]')
          },
          plugins: { legend: { labels: { color: '#e6ebff' } } }
        }
      }));

      const hvData = [];
      if (s && s.history.length >= 2) {
        for (let i = 1; i < s.history.length; i++) {
          const a = s.history[i - 1];
          const b = s.history[i];
          const dt = (b.time - a.time) / 1000;
          if (dt <= 0) continue;
          const dH = haversine(a.lat, a.lon, b.lat, b.lon);
          const v = dH / dt;
          if (Number.isFinite(v)) {
            hvData.push({ x: b.time.getTime(), y: v });
          }
        }
      }

      chart.data.datasets[0].data = hvData;
      chart.update('none');
    })();
  }

  // ======= Boot =======
  window.addEventListener('DOMContentLoaded', () => {
    initLogin();
    initMap();
    initUI();
    restartFetching();
  });
})();

