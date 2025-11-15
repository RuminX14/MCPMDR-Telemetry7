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
