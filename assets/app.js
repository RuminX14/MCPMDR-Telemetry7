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
    lang: localStorage.getItem('lang') || 'pl',
    // mini-mapa w zakładce wykresów
    miniMap: null,
    miniPolyline: null,
    miniMarker: null
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

  // ======= Mapa główna =======
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

    // Fullscreen wykresów / mini-mapy
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

    // Fallback dla typowego układu CSV z radiosondy.info:
    // ID;Type;DateTime;Lat;Lon;Alt;Temp;PRES;HUMI;Speed;Course;RSSI;...
    if (idx.id === -1 && headers.length > 0) idx.id = 0;
    if (idx.type === -1 && headers.length > 1) idx.type = 1;
    if (idx.time === -1 && headers.length > 2) idx.time = 2;
    if (idx.lat === -1 && headers.length > 3) idx.lat = 3;
    if (idx.lon === -1 && headers.length > 4) idx.lon = 4;
    if (idx.alt === -1 && headers.length > 5) idx.alt = 5;
    if (idx.temp === -1 && headers.length > 6) idx.temp = 6;
    if (idx.pressure === -1 && headers.length > 7) idx.pressure = 7;
    if (idx.humidity === -1 && headers.length > 8) idx.humidity = 8;
    if (idx.windSpeed === -1 && headers.length > 9) idx.windSpeed = 9;
    if (idx.windDir === -1 && headers.length > 10) idx.windDir = 10;
    if (idx.rssi === -1 && headers.length > 11) idx.rssi = 11;

    // tylko odrzucamy rekordy bez poprawnego czasu
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

    // usuwanie sond >1h po zakończeniu
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
        polyline: null,
        launchMarker: null,
        burstMarker: null
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
        humidity: p.humidity,
        rssi: extra.rssi
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
    updateLaunchBurstMarkers(s);
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

  // Launch / Burst na trasie lotu
  function updateLaunchBurstMarkers(s) {
    if (!state.map || !s.history.length) return;

    const sorted = s.history.slice().sort((a, b) => a.time - b.time);
    const launch = sorted[0];
    let top = null;
    for (const h of sorted) {
      if (!Number.isFinite(h.alt)) continue;
      if (!top || h.alt > top.alt) top = h;
    }

    if (launch && Number.isFinite(launch.lat) && Number.isFinite(launch.lon)) {
      const latlng = [launch.lat, launch.lon];
      if (!s.launchMarker) {
        s.launchMarker = L.circleMarker(latlng, {
          radius: 5,
          color: '#7bffb0',
          fillColor: '#7bffb0',
          fillOpacity: 0.95
        }).addTo(state.map);
        s.launchMarker.bindTooltip('Launch', { direction: 'top', offset: [0, -6] });
      } else {
        s.launchMarker.setLatLng(latlng);
      }
    }

    if (top && Number.isFinite(top.lat) && Number.isFinite(top.lon)) {
      const latlng2 = [top.lat, top.lon];
      if (!s.burstMarker) {
        s.burstMarker = L.circleMarker(latlng2, {
          radius: 5,
          color: '#ff5470',
          fillColor: '#ff5470',
          fillOpacity: 0.95
        }).addTo(state.map);
        s.burstMarker.bindTooltip('Burst', { direction: 'top', offset: [0, -6] });
      } else {
        s.burstMarker.setLatLng(latlng2);
      }
    }
  }

  function removeSonde(id) {
    const s = state.sondes.get(id);
    if (!s) return;
    if (s.marker) s.marker.remove();
    if (s.polyline) s.polyline.remove();
    if (s.launchMarker) s.launchMarker.remove();
    if (s.burstMarker) s.burstMarker.remove();
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

  // ======= Wykresy – grafanowy styl (czas na X + 2 nowe) =======
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

  function tooltipWithAltitude() {
    return {
      callbacks: {
        label(ctx) {
          const label = ctx.dataset.label || '';
          const val = ctx.formattedValue;
          const raw = ctx.raw;
          const alt = raw && typeof raw === 'object' && Number.isFinite(raw.alt) ? raw.alt : null;
          if (alt != null) {
            return `${label}: ${val} (wys: ${alt.toFixed(0)} m)`;
          }
          return `${label}: ${val}`;
        }
      }
    };
  }

  function resizeCharts() {
    Object.values(state.charts).forEach(c => c.resize());
    if (state.miniMap) {
      setTimeout(() => state.miniMap.invalidateSize(), 80);
    }
  }

  function renderMiniMap(s, hist) {
    const mapEl = document.getElementById('mini-map');
    if (!mapEl) return;

    if (!state.miniMap) {
      state.miniMap = L.map('mini-map', {
        zoomControl: false,
        attributionControl: false
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OSM contributors'
      }).addTo(state.miniMap);
    }

    if (!s || !hist.length) {
      state.miniMap.setView([RX.lat, RX.lon], 4);
      if (state.miniPolyline) state.miniPolyline.setLatLngs([]);
      if (state.miniMarker) {
        state.miniMarker.remove();
        state.miniMarker = null;
      }
      return;
    }

    const path = hist
      .filter(h => Number.isFinite(h.lat) && Number.isFinite(h.lon))
      .map(h => [h.lat, h.lon]);
    if (!path.length) return;

    if (!state.miniPolyline) {
      state.miniPolyline = L.polyline(path, {
        color: 'rgba(61,212,255,0.8)',
        weight: 2
      }).addTo(state.miniMap);
    } else {
      state.miniPolyline.setLatLngs(path);
    }

    const last = hist[hist.length - 1];
    if (!state.miniMarker) {
      state.miniMarker = L.circleMarker([last.lat, last.lon], {
        radius: 4,
        color: '#7bffb0',
        fillColor: '#7bffb0',
        fillOpacity: 0.95
      }).addTo(state.miniMap);
    } else {
      state.miniMarker.setLatLng([last.lat, last.lon]);
    }

    const bounds = L.latLngBounds(path);
    state.miniMap.fitBounds(bounds, { padding: [10, 10] });
  }

  function renderCharts() {
    const s = state.sondes.get(state.activeId);
    const hist = s ? s.history.slice().sort((a, b) => a.time - b.time) : [];

    // mała mapa w zakładce wykresów
    renderMiniMap(s, hist);

    // 1) Voltages vs Temperature – na razie tylko T (czasowy)
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
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
        }
      }));

      const tempData = hist
        .filter(h => Number.isFinite(h.temp))
        .map(h => ({ x: h.time.getTime(), y: h.temp, alt: h.alt }));

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
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
        }
      }));

      chart.data.datasets[0].data = []; // TTGO w przyszłości
      chart.update('none');
    })();

    // 3) Payload Environmental Sensor Data – T / RH / p (czasowo)
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
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
        }
      }));

      const tempData = hist
        .filter(h => Number.isFinite(h.temp))
        .map(h => ({ x: h.time.getTime(), y: h.temp, alt: h.alt }));
      const rhData = hist
        .filter(h => Number.isFinite(h.humidity))
        .map(h => ({ x: h.time.getTime(), y: h.humidity, alt: h.alt }));
      const pData = hist
        .filter(h => Number.isFinite(h.pressure))
        .map(h => ({ x: h.time.getTime(), y: h.pressure, alt: h.alt }));

      chart.data.datasets[0].data = tempData;
      chart.data.datasets[1].data = rhData;
      chart.data.datasets[2].data = pData;
      chart.update('none');
    })();

    // 4) Horizontal Velocity – z historii sondy (czasowo)
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
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
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
            hvData.push({ x: b.time.getTime(), y: v, alt: b.alt });
          }
        }
      }

      chart.data.datasets[0].data = hvData;
      chart.update('none');
    })();

    // 5) Gęstość powietrza vs wysokość
    (function () {
      const id = 'chart-density';
      const chart = ensureChart(id, () => ({
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'Gęstość [kg/m³]',
              data: [],
              borderWidth: 1.2,
              pointRadius: 3,
              showLine: true
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: {
              type: 'linear',
              title: { display: true, text: 'Gęstość [kg/m³]', color: '#e6ebff' },
              grid: { color: 'rgba(134,144,176,.35)' },
              ticks: { color: '#e6ebff' }
            },
            y: commonY('Wysokość [m]')
          },
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
        }
      }));

      const R = 287; // J/(kg*K)
      const densityData = hist
        .filter(h => Number.isFinite(h.pressure) && Number.isFinite(h.temp) && Number.isFinite(h.alt))
        .map(h => {
          const pPa = h.pressure * 100;
          const Tk = h.temp + 273.15;
          const rho = pPa / (R * Tk);
          return { x: rho, y: h.alt, alt: h.alt };
        });

      chart.data.datasets[0].data = densityData;
      chart.update('none');
    })();

    // 6) Moc sygnału i napięcie vs temperatura
    (function () {
      const id = 'chart-signal-temp';
      const chart = ensureChart(id, () => ({
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'RSSI [dB]',
              yAxisID: 'yRssi',
              data: [],
              borderWidth: 1.2,
              pointRadius: 3,
              showLine: false
            },
            {
              label: 'Napięcie [V]',
              yAxisID: 'yU',
              data: [],
              borderWidth: 1.2,
              pointRadius: 3,
              showLine: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: {
              type: 'linear',
              title: { display: true, text: 'Temperatura [°C]', color: '#e6ebff' },
              grid: { color: 'rgba(134,144,176,.35)' },
              ticks: { color: '#e6ebff' }
            },
            yRssi: commonY('RSSI [dB]'),
            yU: { ...commonY('U [V]'), position: 'right' }
          },
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
        }
      }));

      const rssiData = hist
        .filter(h => Number.isFinite(h.rssi) && Number.isFinite(h.temp))
        .map(h => ({ x: h.temp, y: h.rssi, alt: h.alt }));

      // Napięcie – placeholder (na razie brak z radiosondy.info, w TTGO w przyszłości)
      const uData = []; // gdy pojawi się pole voltage, tu je dodać

      chart.data.datasets[0].data = rssiData;
      chart.data.datasets[1].data = uData;
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
