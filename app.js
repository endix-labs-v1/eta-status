// eta status page. Reads services.json and incidents.md from this site and the check history
// from the `data` branch through raw.githubusercontent.com (it sends Access-Control-Allow-Origin: *).
// No custom request headers, so the browser makes a plain GET with no preflight.
(() => {
  'use strict';

  const DATA_URL = 'https://raw.githubusercontent.com/endix-labs-v1/eta-status/data/history.json';
  const DAYS = 90;
  const SLOTS = 288;          // 24 hours of 5-minute slots
  const STALE_MIN = 30;       // no check for this long: say so instead of "All systems working"
  const FILL_SLOTS = 6;       // in the 24-hour view a slot with no run shows the last check up to 30 minutes old
  const REFRESH_MS = 60_000;

  // Local testing only: ?data=...&incidents=... on localhost. Ignored on the public site so a
  // crafted link cannot make status.eta.cash show someone else's numbers.
  const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const q = new URLSearchParams(location.search);
  const pick = (k, d) => (LOCAL && q.get(k)) || d;
  const URLS = {
    data: pick('data', DATA_URL),
    services: './services.json',
    incidents: pick('incidents', './incidents.md'),
  };
  const fakeNow = LOCAL && q.get('now') ? Date.parse(q.get('now')) / 1000 : null;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const nowSec = () => fakeNow ?? Date.now() / 1000;
  const dayKey = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  const hhmm = (sec) => new Date(sec * 1000).toISOString().slice(11, 16) + ' UTC';
  const STATE_TEXT = { up: 'Up', degraded: 'Slow', down: 'Down', notlive: 'Not yet live', nodata: 'No data' };

  let range = 'days';
  let services = [];
  let history = null;

  function joinNames(names) {
    if (names.length < 2) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }

  function pct(c) {
    const total = c[0] + c[1] + c[2];
    if (!total) return null;
    return (c[0] + c[1]) / total; // slow still counts as up: it answered correctly
  }
  function fmtPct(p) {
    if (p == null) return null;
    if (p >= 1) return '100%';
    return `${(Math.floor(p * 10000) / 100).toFixed(2)}%`;
  }
  const dayClass = (p) => (p == null ? '' : p >= 0.99 ? 'up' : p >= 0.95 ? 'degraded' : 'down');

  // counts per service for each of the last 90 UTC days: stored day counts plus raw points
  function dayCounts(id, now) {
    const out = [];
    const index = new Map();
    for (let i = DAYS - 1; i >= 0; i--) {
      const key = dayKey(now - i * 86400);
      const c = [...(history?.days?.[key]?.[id] ?? [0, 0, 0, 0])];
      index.set(key, c);
      out.push({ key, c });
    }
    for (const p of history?.recent ?? []) {
      const res = p.r[id];
      const c = res && index.get(dayKey(p.t));
      const i = res ? ['up', 'degraded', 'down', 'notlive'].indexOf(res[0]) : -1;
      if (c && i >= 0) c[i] += 1;
    }
    return out;
  }

  function slotPoints(id, now) {
    const last = Math.floor(now / 300);
    const bySlot = new Map();
    for (const p of history?.recent ?? []) if (p.r[id]) bySlot.set(Math.floor(p.t / 300), p);
    const out = [];
    let carry = null;
    // walk forward from a little before the window so the first slots can carry a check in
    for (let s = last - SLOTS + 1 - FILL_SLOTS; s <= last; s++) {
      const p = bySlot.get(s);
      if (p) carry = { p, s };
      else if (carry && s - carry.s > FILL_SLOTS) carry = null;
      if (s > last - SLOTS) out.push(carry ? carry.p : null);
    }
    return out;
  }

  function cellDetailDay(d) {
    const [u, g, x, n] = d.c;
    if (u + g + x === 0) return `${d.key}: ${n ? 'not yet live' : 'no data'}`;
    const total = u + g + x;
    const parts = [`${d.key}: ${fmtPct(pct(d.c))} up`];
    if (x) parts.push(`${x} of ${total} checks failed`);
    else if (g) parts.push(`${g} of ${total} checks slow`);
    else parts.push(`${total} checks`);
    return parts.join(', ');
  }
  function cellDetailSlot(p, id) {
    if (!p) return 'No check in this slot';
    const [state, status, ms, note] = p.r[id];
    const bits = [`${hhmm(p.t)}: ${STATE_TEXT[state] || state}`];
    if (state === 'down') bits.push(note || `HTTP ${status}`);
    else if (state !== 'notlive') bits.push(`${ms} ms`);
    return bits.join(', ');
  }

  function renderOverall(now) {
    const box = $('overall');
    const latest = history?.recent?.at(-1);
    let cls = '', text, sub = '';
    if (!history) {
      text = 'Status data could not be loaded';
      sub = 'Try again in a minute.';
    } else if (!latest) {
      text = 'Waiting for the first check';
    } else {
      const ageMin = Math.round((now - latest.t) / 60);
      sub = `Last check ${hhmm(latest.t)} (${ageMin < 1 ? 'just now' : `${ageMin} min ago`})`;
      const named = (state) => services.filter((s) => latest.r[s.id]?.[0] === state).map((s) => s.name);
      const down = named('down');
      const slow = named('degraded');
      if (ageMin > STALE_MIN) {
        cls = 'warn';
        text = `No check in the last ${ageMin} minutes`;
        sub += '. GitHub sometimes delays scheduled runs; this page will catch up.';
      } else if (down.length) {
        cls = 'bad';
        text = `${joinNames(down)} ${down.length > 1 ? 'are' : 'is'} down`;
      } else if (slow.length) {
        cls = 'warn';
        text = `${joinNames(slow)} ${slow.length > 1 ? 'are' : 'is'} slow`;
      } else {
        cls = 'ok';
        text = 'All systems working';
      }
    }
    box.className = `overall ${cls}`;
    $('overall-text').textContent = text;
    $('overall-sub').textContent = sub || ' ';
  }

  function renderServices(now) {
    const root = $('services');
    root.replaceChildren();
    const latest = history?.recent?.at(-1);
    for (const s of services) {
      const row = el('div', 'svc');
      const top = el('div', 'top');
      top.append(el('span', 'name', s.name));
      const res = latest?.r[s.id];
      const state = res ? res[0] : 'nodata';
      const st = el('span', `state s-${state}`);
      st.append(el('span', 'dot'), el('span', null, STATE_TEXT[state] || state));
      if (res && (state === 'up' || state === 'degraded')) st.append(el('span', 'ms', `${res[2]} ms`));
      top.append(st);
      row.append(top);

      const bar = el('div', range === 'hours' ? 'bar fine' : 'bar');
      const foot = el('div', 'foot');
      const left = el('span', 'end');
      const mid = el('span', 'mid');
      const right = el('span', 'end');
      let details = [];
      let summary;

      if (range === 'days') {
        const days = dayCounts(s.id, now);
        bar.style.setProperty('--n', DAYS);
        const sum = [0, 0, 0, 0];
        for (const d of days) {
          d.c.forEach((v, i) => (sum[i] += v));
          const cell = el('span', dayClass(pct(d.c)));
          bar.append(cell);
          details.push(cellDetailDay(d));
        }
        const p = fmtPct(pct(sum));
        summary = p ? `${p} uptime` : sum[3] ? 'Not yet live' : 'No data yet';
        left.textContent = '90 days ago';
        right.textContent = 'Today';
        bar.setAttribute('aria-label', `${s.name}, last 90 days: ${summary}`);
      } else {
        const slots = slotPoints(s.id, now);
        bar.style.setProperty('--n', SLOTS);
        const sum = [0, 0, 0, 0];
        for (const p of history?.recent ?? []) {
          const r = p.r[s.id];
          if (r && p.t > now - 86400) sum[['up', 'degraded', 'down', 'notlive'].indexOf(r[0])] += 1;
        }
        for (const p of slots) {
          bar.append(el('span', p ? (p.r[s.id][0] === 'notlive' ? '' : p.r[s.id][0]) : ''));
          details.push(cellDetailSlot(p, s.id));
        }
        const pc = fmtPct(pct(sum));
        summary = pc ? `${pc} uptime` : sum[3] ? 'Not yet live' : 'No data yet';
        left.textContent = '24 hours ago';
        right.textContent = 'Now';
        bar.setAttribute('aria-label', `${s.name}, last 24 hours: ${summary}`);
      }
      bar.setAttribute('role', 'img');
      mid.textContent = summary;
      foot.append(left, mid, right);

      let selected = null;
      const show = (target) => {
        const i = [...bar.children].indexOf(target);
        if (i < 0) return;
        if (selected) selected.classList.remove('sel');
        selected = target;
        target.classList.add('sel');
        mid.textContent = details[i];
      };
      const reset = () => {
        if (selected) selected.classList.remove('sel');
        selected = null;
        mid.textContent = summary;
      };
      bar.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') show(e.target); });
      bar.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') reset(); });
      bar.addEventListener('click', (e) => (selected === e.target ? reset() : show(e.target)));

      row.append(bar, foot);
      root.append(row);
    }
  }

  // incidents.md format (see README):
  //   ## 2026-11-17 14:20 UTC | Title
  //   Status: Resolved
  //   Affected: api, mcp
  //
  //   Paragraphs, and "- " lines for timed updates.
  function parseIncidents(md) {
    const text = md.replace(/<!--[\s\S]*?-->/g, '');
    const out = [];
    for (const part of text.split(/^## +/m).slice(1)) {
      const lines = part.split('\n');
      const m = lines[0].match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?(?:\s*UTC)?\s*\|\s*(.+?)\s*$/);
      if (!m) { console.warn('incidents.md: skipped heading, expected "YYYY-MM-DD HH:MM UTC | Title":', lines[0]); continue; }
      const inc = { date: m[1], time: m[2] || '', title: m[3], status: '', affected: [], blocks: [] };
      let i = 1;
      for (; i < lines.length; i++) {
        const kv = lines[i].match(/^(status|affected)\s*:\s*(.*)$/i);
        if (kv) {
          if (kv[1].toLowerCase() === 'status') inc.status = kv[2].trim();
          else inc.affected = kv[2].split(',').map((x) => x.trim()).filter(Boolean);
        } else if (lines[i].trim() !== '') break;
      }
      let para = [];
      let list = null;
      const flush = () => { if (para.length) inc.blocks.push({ p: para.join(' ') }); para = []; };
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (/^\s*[-*] /.test(l)) {
          flush();
          if (!list) { list = []; inc.blocks.push({ ul: list }); }
          list.push(l.replace(/^\s*[-*] /, '').trim());
        } else if (!l.trim()) { flush(); list = null; }
        else { list = null; para.push(l.trim()); }
      }
      flush();
      out.push(inc);
    }
    return out.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  }

  function renderIncidents(md) {
    const root = $('incidents');
    root.replaceChildren();
    if (md == null) { root.append(el('p', 'none', 'Incidents could not be loaded.')); return; }
    const list = parseIncidents(md);
    if (!list.length) { root.append(el('p', 'none', 'No incidents posted.')); return; }
    const names = Object.fromEntries(services.map((s) => [s.id, s.name]));
    for (const inc of list) {
      const box = el('article', 'inc');
      const meta = el('div', 'meta');
      meta.append(el('span', null, `${inc.date}${inc.time ? ` ${inc.time} UTC` : ''}`));
      if (inc.status) meta.append(el('span', `status${/^resolved$/i.test(inc.status) ? ' resolved' : ''}`, inc.status));
      if (inc.affected.length) meta.append(el('span', null, inc.affected.map((a) => names[a] || a).join(', ')));
      box.append(meta, el('h3', null, inc.title));
      for (const b of inc.blocks) {
        if (b.p) box.append(el('p', null, b.p));
        else {
          const ul = el('ul');
          for (const item of b.ul) ul.append(el('li', null, item));
          box.append(ul);
        }
      }
      root.append(box);
    }
  }

  function render() {
    const now = nowSec();
    renderOverall(now);
    renderServices(now);
  }

  async function get(url, kind) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return kind === 'json' ? r.json() : r.text();
  }

  async function load() {
    const [svc, data, inc] = await Promise.allSettled([
      services.length ? Promise.resolve({ services }) : get(URLS.services, 'json'),
      get(URLS.data, 'json'),
      get(URLS.incidents, 'text'),
    ]);
    if (svc.status === 'fulfilled') services = svc.value.services;
    history = data.status === 'fulfilled' && Array.isArray(data.value?.recent) ? data.value : history;
    for (const r of [svc, data, inc]) if (r.status === 'rejected') console.warn(r.reason);
    render();
    renderIncidents(inc.status === 'fulfilled' ? inc.value : null);
  }

  for (const b of document.querySelectorAll('.seg button')) {
    b.addEventListener('click', () => {
      range = b.dataset.range;
      for (const o of document.querySelectorAll('.seg button')) o.setAttribute('aria-pressed', String(o === b));
      render();
    });
  }

  load();
  setInterval(load, REFRESH_MS);
})();
