/* Shared JS logic for schedule templates (full, emergency, week)
 * Exposes global: window.Schedule.scheduleInit(options)
 * Options: { mode: 'full' | 'emergency' | 'week' | 'auto' }
 * Behavior keeps parity with previous inline scripts in all templates.
 */
(function(){
  'use strict';

  function initThemeFromQuery() {
    try {
      const qs = new URLSearchParams(location.search);
      if (qs.get('theme') === 'dark') document.body.classList.add('theme-dark');
    } catch (_) {}
  }

  function pickGpvKey(data) {
    try {
      const qs = new URLSearchParams(location.search);
      const fromUrl = qs.get('gpv');
      if (fromUrl && data?.preset?.data && data.preset.data[fromUrl]) return fromUrl;
    } catch (e) {}
    if (window.__GPV_KEY__ && data?.preset?.data && data.preset.data[window.__GPV_KEY__]) return window.__GPV_KEY__;
    const keys = Object.keys(data?.preset?.data || {});
    const firstGpv = keys.find(k => /^GPV\d+\.\d+$/.test(k));
    return firstGpv || 'GPV1.2';
  }

  // Map cell state to icon file path
  function stateIconSrc(state) {
    switch (state) {
      case 'no': return 'icons/no.svg';
      case 'maybe': return 'icons/maybe.svg';
      case 'mfirst':
      case 'first': return 'icons/mfirst.svg';
      case 'msecond':
      case 'second': return 'icons/msecond.svg';
      default: return null;
    }
  }

  // For the Today table we use a different pair of icons for half-hour markers
  function stateIconSrcToday(state) {
    if (state === 'mfirst' || state === 'first') return 'icons/nfirst.svg';
    if (state === 'msecond' || state === 'second') return 'icons/nsecond.svg';
    return stateIconSrc(state);
  }

  async function loadData() {
    if (window.__SCHEDULE__) return window.__SCHEDULE__;
    let regionId = 'kyiv-region';
    try {
      const qs = new URLSearchParams(location.search);
      regionId = qs.get('region') || regionId;
    } catch (e) {}
    const url = `../data/${regionId}.json`;
    try {
      const res = await fetch(url);
      return await res.json();
    } catch (e) {
      const meta = document.getElementById('meta');
      if (meta) meta.textContent = 'Не вдалося завантажити дані (' + url + '). Запустіть локальний сервер (наприклад: npx serve або python3 -m http.server) з кореня проєкту.';
      throw e;
    }
  }

  function formatLastUpdated(data) {
    let updatedLabel = '';
    if (data.lastUpdated) {
      try {
        const d = new Date(data.lastUpdated);
        const parts = new Intl.DateTimeFormat('uk-UA', {
          timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(d);
        const get = t => parts.find(p => p.type === t)?.value || '';
        const dd = get('day');
        const mm = get('month');
        const yyyy = get('year');
        const hh = get('hour');
        const min = get('minute');
        updatedLabel = `${dd}.${mm}.${yyyy} ${hh}:${min}`;
      } catch (_) {}
    }
    if (!updatedLabel && data.fact && data.fact.update) {
      updatedLabel = data.fact.update;
    }
    return updatedLabel;
  }

  function injectLastUpdatedIfPresent(data) {
    const el = document.getElementById('lastUpdated');
    if (!el) return;
    const label = formatLastUpdated(data);
    if (label) el.textContent = 'Дата та час останнього оновлення інформації на графіку: ' + label;
  }

  function injectMetaIfPresent(data) {
    const meta = document.getElementById('meta');
    if (!meta) return;
    const hash = data.meta && data.meta.contentHash;
    if (hash) {
      meta.textContent = 'contentHash: ' + hash;
    } else if (data.fact && data.fact.update) {
      meta.textContent = 'Оновлено: ' + data.fact.update;
    }
  }

  function injectGroupBadgeIfPresent(data, gpvKey) {
    try {
      const h1 = document.querySelector('.container > h1');
      if (h1) {
        const names = data?.preset?.sch_names || {};
        let label = names[gpvKey] || '';
        if (label) {
          label = label.replace(/^Черга\b\s*/, 'Черга: ');
        } else if (gpvKey) {
          const m = String(gpvKey).match(/^GPV(\d+)\.(\d+)$/);
          if (m) label = `Черга: ${m[1]}.${m[2]}`;
        }
        if (label) {
          let badge = h1.querySelector('.group-badge');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'group-badge';
            h1.appendChild(badge);
          }
          badge.textContent = label;
        }
      }
    } catch (_) {}
  }

  function computeTodayWeekdayIdx(data) {
    let todayIdx = null;
    try {
      const epoch = data?.fact?.today;
      if (epoch != null) {
        const baseDate = new Date(Number(epoch) * 1000);
        const w = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', weekday: 'short' }).format(baseDate);
        const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
        todayIdx = map[w] || null;
      }
    } catch (_) {}
    return todayIdx;
  }

  function buildWeek(preset, gpvKey, todayWeekdayIdx) {
    const table = document.getElementById('matrix');
    if (!table) return;
    table.innerHTML = '';

    const tzKeys = Object.keys(preset.time_zone).map(Number).sort((a,b)=>a-b);
    const times = tzKeys.map(k => preset.time_zone[String(k)][0]);

    const dayKeys = Object.keys(preset.days).map(Number).sort((a,b)=>a-b);

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');

    const corner = document.createElement('th');
    corner.innerHTML = 'Часові<br>проміжки';
    hr.appendChild(corner);

    for (const t of times) {
      const th = document.createElement('th');
      const div = document.createElement('div');
      div.className = 'vlabel';
      div.textContent = t;
      th.appendChild(div);
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    const tbody = document.createElement('tbody');
    const schedule = preset.data && preset.data[gpvKey];

    if (!schedule) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = 'Помилка: відсутні дані для ' + gpvKey;
      th.colSpan = 1 + tzKeys.length;
      tr.appendChild(th);
      tbody.appendChild(tr);
      table.appendChild(thead);
      table.appendChild(tbody);
      return;
    }

    dayKeys.forEach(dk => {
      const dayName = preset.days[String(dk)];
      const tr = document.createElement('tr');
      if (todayWeekdayIdx && Number(dk) === Number(todayWeekdayIdx)) {
        tr.classList.add('is-today');
      }
      const th = document.createElement('th');
      th.textContent = dayName; tr.appendChild(th);

      tzKeys.forEach(hk => {
        const td = document.createElement('td');
        const value = schedule?.[String(dk)]?.[String(hk)];
        if (value) {
          td.classList.add('state-' + value);
          const timeLabel = preset.time_zone[String(hk)]?.[0] || '';
          const desc = preset.time_type?.[value] || value;
          td.title = dayName + ' ' + timeLabel + ' — ' + desc;
          const iconSrc = stateIconSrc(value);
          if (iconSrc) {
            const img = document.createElement('img');
            img.className = 'cell-icon';
            img.src = iconSrc;
            img.width = 20; img.height = 20; img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.decoding = 'async';
            td.appendChild(img);
          }
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);
  }

  function buildToday(preset, fact, gpvKey) {
    const table = document.getElementById('today');
    if (!table) return;
    table.innerHTML = '';

    const tzKeys = Object.keys(preset.time_zone).map(Number).sort((a,b)=>a-b);

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.innerHTML = 'Часові<br>проміжки';
    hr.appendChild(corner);
    for (const hk of tzKeys) {
      const th = document.createElement('th');
      const div = document.createElement('div');
      div.className = 'vlabel';
      div.textContent = preset.time_zone[String(hk)]?.[0] || '';
      th.appendChild(div);
      hr.appendChild(th);
    }
    thead.appendChild(hr);

    function renderRow(label, dayEpoch) {
      const tr = document.createElement('tr');
      const rowTh = document.createElement('th');
      rowTh.textContent = label;
      tr.appendChild(rowTh);

      const dayObj = fact && fact.data && (dayEpoch != null) && fact.data[String(dayEpoch)];
      const schedule = dayObj && (dayObj[gpvKey]);

      tzKeys.forEach(hk => {
        const td = document.createElement('td');
        const raw = schedule?.[String(hk)];
        if (raw) td.classList.add('state-' + raw);
        const timeLabel = preset.time_zone[String(hk)]?.[0] || '';
        const desc = raw ? (preset.time_type?.[raw] || raw) : '';
        if (desc) td.title = label + ' ' + timeLabel + ' — ' + desc;
        const iconSrc = raw ? stateIconSrcToday(raw) : null;
        if (iconSrc) {
          const img = document.createElement('img');
          img.className = 'cell-icon';
          img.src = iconSrc;
          img.width = 20; img.height = 20; img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.decoding = 'async';
          td.appendChild(img);
        }
        tr.appendChild(td);
      });
      return tr;
    }

    const tbody = document.createElement('tbody');

    const todayEpoch = (fact && fact.today != null) ? Number(fact.today) : null;
    if (todayEpoch != null) {
      tbody.appendChild(renderRow('Сьогодні', todayEpoch));
    }

    let tomorrowEpoch = null;
    try {
      const keys = Object.keys(fact?.data || {}).map(Number).filter(n => !Number.isNaN(n));
      if (keys.length) {
        const greater = keys.filter(k => todayEpoch != null ? k > todayEpoch : true).sort((a,b)=>a-b);
        tomorrowEpoch = greater[0] ?? keys.find(k => k !== todayEpoch) ?? null;
      }
    } catch (_) {}

    if (tomorrowEpoch != null && tomorrowEpoch !== todayEpoch) {
      let label = 'Завтра';
      try {
        const d = new Date(Number(tomorrowEpoch) * 1000);
        const parts = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit' }).formatToParts(d);
        const get = t => parts.find(p => p.type === t)?.value || '';
        const dd = get('day');
        const mm = get('month');
        if (dd && mm) label = `Завтра (${dd}.${mm})`;
      } catch (_) {}
      tbody.appendChild(renderRow(label, tomorrowEpoch));
    }

    table.appendChild(thead);
    table.appendChild(tbody);
  }

  function extractGroupNumber(gpvKey, names) {
    // Return string like "1.2" from GPV1.2 or from the sch_names label
    if (gpvKey) {
      const m = String(gpvKey).match(/^GPV(\d+)\.(\d+)$/);
      if (m) return `${m[1]}.${m[2]}`;
    }
    const label = names && gpvKey ? names[gpvKey] : '';
    if (label) {
      const mm = label.match(/(\d+)\.(\d+)/);
      if (mm) return `${mm[1]}.${mm[2]}`;
    }
    return '';
  }

  function buildSummary(preset, fact, gpvKey) {
    // Elements expected in summary template
    const badge = document.querySelector('.group-badge-left');
    const note = document.querySelector('.summary-status');
    const dateEl = document.querySelector('.summary-date');
    const list = document.querySelector('.summary-intervals');
    const statusBadge = document.querySelector('.status-badge');
    if (!note || !list) return;

    // Build today OFF intervals (strict OFF = state 'no', plus half-hour first/second)
    const todayEpoch = (fact && fact.today != null) ? Number(fact.today) : null;
    const dayObj = (todayEpoch != null) ? (fact && fact.data && fact.data[String(todayEpoch)]) : null;
    const schedule = dayObj && (dayObj[gpvKey]);

    // Inject date line "Сьогодні (DD.MM)"
    if (dateEl && Number.isFinite(todayEpoch)) {
      try {
        const d = new Date(todayEpoch * 1000);
        const parts = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit' }).formatToParts(d);
        const get = t => parts.find(p => p.type === t)?.value || '';
        const dd = get('day');
        const mm = get('month');
        if (dd && mm) dateEl.textContent = `Сьогодні (${dd}.${mm}),`;
      } catch (_) {}
    }

    const tzKeys = Object.keys(preset.time_zone || {}).map(Number).sort((a,b)=>a-b);
    const labels = tzKeys.map(k => preset.time_zone[String(k)]?.[0] || '');

    // Parse time label to start minutes (00:00 = 0)
    function parseStartMinutes(label) {
      if (!label) return NaN;
      const s = String(label).trim();
      // 1) HH:MM or H:MM
      let m = s.match(/^([0-9]{1,2}):([0-9]{2})$/);
      if (m) {
        const hh = Math.min(24, Math.max(0, Number(m[1])));
        const mm = Math.min(59, Math.max(0, Number(m[2])));
        return (hh * 60) + mm;
      }
      // 2) "H-H+1" or "HH-HH" — take the first hour as start
      m = s.match(/^([0-9]{1,2})\s*-\s*([0-9]{1,2})$/);
      if (m) {
        const hh = Math.min(24, Math.max(0, Number(m[1])));
        return hh * 60;
      }
      // 3) plain hour "H" or "HH"
      m = s.match(/^([0-9]{1,2})$/);
      if (m) {
        const hh = Math.min(24, Math.max(0, Number(m[1])));
        return hh * 60;
      }
      return NaN;
    }
    const startsMin = labels.map(parseStartMinutes);

    // Build 30/60-minute aware OFF chunks and merge into intervals
    const intervals = [];
    let allYes = false;
    if (schedule) {
      const chunks = []; // array of [startMin, endMin] in minutes from 00:00
      const getState = (idx) => schedule[String(tzKeys[idx])] || '';
      let yesOnly = true;
      for (let i = 0; i < tzKeys.length; i++) {
        const s = startsMin[i];
        const e = (i + 1 < tzKeys.length) ? startsMin[i + 1] : 24 * 60;
        if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
        const st = getState(i);
        if (st === 'no') {
          chunks.push([s, e]);
          yesOnly = false;
        } else if (st === 'first' || st === 'mfirst') {
          const mid = Math.min(s + 30, e);
          if (mid > s) chunks.push([s, mid]);
          yesOnly = false;
        } else if (st === 'second' || st === 'msecond') {
          const mid = Math.min(s + 30, e);
          if (e > mid) chunks.push([mid, e]);
          yesOnly = false;
        } else if (st === 'maybe') {
          yesOnly = false; // not strictly yes
        } else if (st === 'yes') {
          // keep yesOnly true
        } else {
          // unknown -> not strictly yes
          yesOnly = false;
        }
      }

      // Merge contiguous/overlapping chunks into consolidated intervals
      if (chunks.length) {
        chunks.sort((a, b) => a[0] - b[0]);
        let cur = chunks[0].slice();
        for (let i = 1; i < chunks.length; i++) {
          const [cs, ce] = chunks[i];
          if (cs <= cur[1]) {
            // overlap or touching -> extend
            cur[1] = Math.max(cur[1], ce);
          } else {
            intervals.push(cur);
            cur = [cs, ce];
          }
        }
        intervals.push(cur);
      }
      allYes = yesOnly;
    }

    // Render
    list.innerHTML = '';
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

    if (intervals.length === 0 && allYes) {
      // All YES for today: ON all day
      note.textContent = 'світло буде весь день';
      if (statusBadge) {
        statusBadge.textContent = 'ON';
        statusBadge.className = 'badge-on status-badge';
      }
      // No intervals/placeholder needed when ON all day
    } else if (intervals.length === 0) {
      // No OFF chunks but not all strictly yes (missing data or maybe values)
      note.textContent = 'Відключень за даними графіка не очікується';
      if (statusBadge) {
        statusBadge.textContent = 'OFF';
        statusBadge.className = 'legend-box state-no badge-off status-badge';
      }
      const div = document.createElement('div');
      div.textContent = '—';
      list.appendChild(div);
    } else {
      // There are OFF intervals
      note.textContent = 'світло буде відсутнє';
      if (statusBadge) {
        statusBadge.textContent = 'OFF';
        statusBadge.className = 'legend-box state-no badge-off status-badge';
      }
      for (const [s, e] of intervals) {
        const row = document.createElement('div');
        row.textContent = `з ${fmt(s)} до ${fmt(e)}`;
        list.appendChild(row);
      }
    }

    // Badge number only (e.g., 1.2)
    if (badge) {
      const num = extractGroupNumber(gpvKey, preset?.sch_names || {});
      if (num) badge.textContent = num;
    }
  }

  async function scheduleInit(options) {
    const mode = (options && options.mode) || 'auto';
    initThemeFromQuery();

    let data;
    try {
      data = await loadData();
    } catch (e) {
      // data failed to load; stop here
      return;
    }

    const gpvKey = pickGpvKey(data);

    // lastUpdated/meta only if such elements exist (full template)
    injectLastUpdatedIfPresent(data);

    // For summary mode, do not auto-inject the default badge (we have a custom left badge)
    const isSummary = (mode === 'summary');
    if (!isSummary) {
      // badge is shown in all templates where an H1 exists
      injectGroupBadgeIfPresent(data, gpvKey);
    }

    const hasToday = !!document.getElementById('today');
    const hasMatrix = !!document.getElementById('matrix');

    if (mode === 'full' || (mode === 'auto' && hasToday && hasMatrix)) {
      buildToday(data.preset, data.fact, gpvKey);
      const idx = computeTodayWeekdayIdx(data);
      buildWeek(data.preset, gpvKey, idx);
      injectMetaIfPresent(data);
      return;
    }

    if ((mode === 'emergency' || mode === 'auto') && hasToday) {
      buildToday(data.preset, data.fact, gpvKey);
      // also inject meta hash if element exists
      injectMetaIfPresent(data);
    }

    if ((mode === 'week' || mode === 'auto') && hasMatrix) {
      const idx = computeTodayWeekdayIdx(data);
      buildWeek(data.preset, gpvKey, idx);
      // also inject meta hash if element exists
      injectMetaIfPresent(data);
    }

    if (mode === 'summary' || (mode === 'auto' && document.querySelector('.summary-card'))) {
      buildSummary(data.preset, data.fact, gpvKey);
      // inject meta hash for summary template if present
      injectMetaIfPresent(data);
    }
  }

  // Export
  window.Schedule = {
    scheduleInit,
    // exposing helpers for potential debugging
    _pickGpvKey: pickGpvKey,
    _computeTodayIdx: computeTodayWeekdayIdx
  };
})();
