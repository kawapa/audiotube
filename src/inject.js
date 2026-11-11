// AudioTube – MAIN world.
// Podejście "atrapa wideo": player dostaje normalne formaty (więc nie zgłasza błędu),
// ale zamiast prawdziwego bufora wideo MediaSource dostaje atrapę, która ignoruje dane
// i zawsze raportuje "wszystko zbuforowane" – player nie ma po co pobierać kolejnych segmentów wideo.
(() => {
  const KEY = 'audiotube_enabled';
  const TAG = '[AudioTube]';
  const enabled = () => {
    try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
  };
  // Diagnostyka: w konsoli strony wpisz localStorage.audiotube_debug = '1' i odśwież.
  const debug = () => {
    try { return localStorage.getItem('audiotube_debug') === '1'; } catch { return false; }
  };
  const isVideoType = (t) => typeof t === 'string' && /^video\//i.test(t);

  if (!window.MediaSource) return;

  // --- Atrapa SourceBuffer ----------------------------------------------
  const EVENT_HANDLERS = ['onabort', 'onerror', 'onupdate', 'onupdateend', 'onupdatestart'];

  class FakeSourceBuffer extends EventTarget {
    constructor(mediaSource, type) {
      super();
      this._ms = mediaSource;
      this._type = type;
      this._updating = false;
      this._appends = 0;
      this.mode = 'segments';
      this.timestampOffset = 0;
      this.appendWindowStart = 0;
      this.appendWindowEnd = Infinity;
      EVENT_HANDLERS.forEach((name) => {
        let handler = null;
        const evt = name.slice(2);
        Object.defineProperty(this, name, {
          get: () => handler,
          set: (fn) => {
            if (handler) this.removeEventListener(evt, handler);
            handler = fn;
            if (fn) this.addEventListener(evt, fn);
          },
        });
      });
    }
    get updating() { return this._updating; }
    get buffered() {
      const d = this._ms.duration;
      const end = Number.isFinite(d) && d > 0 ? d : 0;
      return {
        length: end ? 1 : 0,
        start: (i) => { if (i !== 0 || !end) throw new DOMException('index', 'IndexSizeError'); return 0; },
        end: (i) => { if (i !== 0 || !end) throw new DOMException('index', 'IndexSizeError'); return end; },
      };
    }
    _fakeUpdate() {
      this._updating = true;
      this.dispatchEvent(new Event('updatestart'));
      setTimeout(() => {
        this._updating = false;
        this.dispatchEvent(new Event('update'));
        this.dispatchEvent(new Event('updateend'));
      }, 0);
    }
    appendBuffer() { this._appends++; this._fakeUpdate(); }
    appendStream() { this._fakeUpdate(); }
    remove() { this._fakeUpdate(); }
    abort() { this._updating = false; }
    changeType(type) { this._type = type; }
  }

  // --- Hooki MediaSource -------------------------------------------------
  const isSupported = MediaSource.isTypeSupported.bind(MediaSource);
  const origAdd = MediaSource.prototype.addSourceBuffer;

  MediaSource.prototype.addSourceBuffer = function (type) {
    if (enabled() && isVideoType(type)) {
      console.log(TAG, 'atrapa SourceBuffer dla', type);
      return new FakeSourceBuffer(this, type);
    }
    return origAdd.apply(this, arguments);
  };

  // --- Diagnostyka: co jeszcze leci z googlevideo ------------------------
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (typeof url === 'string' && url.includes('/videoplayback')) {
        const u = new URL(url, location.href);
        if (debug()) console.log(TAG, 'videoplayback',
          'itag=' + u.searchParams.get('itag'),
          'mime=' + u.searchParams.get('mime'),
          'range=' + u.searchParams.get('range'));
      }
    } catch (e) { /* ignoruj */ }
    return xhrOpen.apply(this, arguments);
  };

  // --- SABR: wymuś "tylko audio" w ClientAbrState ------------------------
  // VideoPlaybackAbrRequest (nieoficjalny schemat): pole 1 = ClientAbrState,
  // w nim pole 40 (varint) = enabled_track_types_bitfield: 0 audio+wideo, 1 tylko audio, 2 tylko wideo.
  function readVarint(buf, pos) {
    let result = 0, shift = 0;
    for (;;) {
      if (pos >= buf.length) return null;
      const b = buf[pos++];
      result += (b & 0x7f) * Math.pow(2, shift); // Number wystarcza dla tagów i długości
      if (!(b & 0x80)) return [result, pos];
      shift += 7;
      if (shift > 63) return null;
    }
  }
  function writeVarint(n) {
    const out = [];
    while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
    out.push(n);
    return Uint8Array.from(out);
  }
  // Zwraca listę pól { num, wire, start, end, dataStart, dataEnd } albo null przy błędzie.
  function parseFields(buf) {
    const fields = [];
    let pos = 0;
    while (pos < buf.length) {
      const start = pos;
      const tag = readVarint(buf, pos); if (!tag) return null;
      pos = tag[1];
      const num = Math.floor(tag[0] / 8), wire = tag[0] % 8;
      let dataStart = pos, dataEnd;
      if (wire === 0) { const v = readVarint(buf, pos); if (!v) return null; dataEnd = v[1]; }
      else if (wire === 1) dataEnd = pos + 8;
      else if (wire === 5) dataEnd = pos + 4;
      else if (wire === 2) {
        const l = readVarint(buf, pos); if (!l) return null;
        dataStart = l[1]; dataEnd = dataStart + l[0];
      } else return null; // grupy – nieobsługiwane
      if (dataEnd > buf.length) return null;
      fields.push({ num, wire, start, end: dataEnd, dataStart, dataEnd });
      pos = dataEnd;
    }
    return fields;
  }
  // Diagnostyka: czytelny zrzut struktury protobuf (zagnieżdżone wiadomości rozpoznawane heurystycznie).
  function dumpFields(buf, depth) {
    const fields = parseFields(buf);
    if (!fields) return null;
    return fields.map((f) => {
      if (f.wire === 0) return f.num + '=' + readVarint(buf, f.dataStart)[0];
      if (f.wire === 2) {
        const sub = buf.subarray(f.dataStart, f.dataEnd);
        const nested = depth > 0 && sub.length ? dumpFields(sub, depth - 1) : null;
        return f.num + (nested && nested.length ? ':{' + nested + '}' : ':len' + sub.length);
      }
      return f.num + '~w' + f.wire;
    }).join(',');
  }
  let dumps = 0;

  // Diagnostyka: analiza odpowiedzi UMP (bajty per itag).
  function readUmpVarint(buf, pos) {
    if (pos >= buf.length) return null;
    const b0 = buf[pos];
    const size = b0 < 128 ? 1 : b0 < 192 ? 2 : b0 < 224 ? 3 : b0 < 240 ? 4 : 5;
    if (pos + size > buf.length) return null;
    let val;
    if (size === 1) val = b0;
    else if (size === 5) {
      val = (buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16) | (buf[pos + 4] << 24)) >>> 0;
    } else {
      val = b0 & ((1 << (8 - size)) - 1);
      let shift = 8 - size;
      for (let i = 1; i < size; i++) { val += buf[pos + i] * Math.pow(2, shift); shift += 8; }
    }
    return [val, pos + size];
  }
  function analyzeUmp(buf) {
    const itagByHeader = {};
    const bytesByItag = {};
    const partCounts = {};
    let pos = 0;
    while (pos < buf.length) {
      const t = readUmpVarint(buf, pos); if (!t) break;
      const s = readUmpVarint(buf, t[1]); if (!s) break;
      const payload = buf.subarray(s[1], s[1] + s[0]);
      partCounts[t[0]] = (partCounts[t[0]] || 0) + 1;
      if (t[0] === 20) { // MEDIA_HEADER: 1=header_id, 3=itag
        const fs = parseFields(payload);
        if (fs) {
          const id = fs.find((f) => f.num === 1), itag = fs.find((f) => f.num === 3);
          if (id && itag) itagByHeader[readVarint(payload, id.dataStart)[0]] = readVarint(payload, itag.dataStart)[0];
        }
      } else if (t[0] === 21 && payload.length) { // MEDIA: pierwszy bajt = header_id
        const itag = itagByHeader[payload[0]];
        bytesByItag[itag] = (bytesByItag[itag] || 0) + payload.length - 1;
      }
      pos = s[1] + s[0];
    }
    return { total: buf.length, bytesByItag, partCounts };
  }

  function concat(parts) {
    const len = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const AUDIO_ONLY_FIELD = Uint8Array.of(0xc0, 0x02, 0x01); // tag pola 40 (varint) + wartość 1

  function patchSabrBody(bytes) {
    const top = parseFields(bytes);
    if (!top) return null;
    const parts = [];
    let patched = false;
    for (const f of top) {
      if (f.num === 1 && f.wire === 2 && !patched) {
        const inner = bytes.subarray(f.dataStart, f.dataEnd);
        const sub = parseFields(inner);
        if (!sub) return null;
        const innerParts = [];
        for (const g of sub) {
          if (g.num === 40 && g.wire === 0) continue; // usuń istniejące
          innerParts.push(inner.subarray(g.start, g.end));
        }
        innerParts.push(AUDIO_ONLY_FIELD);
        const newInner = concat(innerParts);
        parts.push(Uint8Array.of(0x0a), writeVarint(newInner.length), newInner);
        patched = true;
      } else {
        parts.push(bytes.subarray(f.start, f.end));
      }
    }
    if (!patched) { // brak ClientAbrState – dodaj
      parts.unshift(Uint8Array.of(0x0a), writeVarint(AUDIO_ONLY_FIELD.length), AUDIO_ONLY_FIELD);
    }
    return concat(parts);
  }
  function bodyToBytes(body) {
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return null;
  }

  let warnedRequestInput = false;
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (url && url.includes('/videoplayback')) {
        const u = new URL(url, location.href);
        const sabr = u.searchParams.get('sabr');
        if (debug()) console.log(TAG, 'fetch videoplayback',
          'itag=' + u.searchParams.get('itag'),
          'mime=' + u.searchParams.get('mime'),
          'sabr=' + sabr);
        if (sabr === '1' && enabled()) {
          const bytes = init && init.body ? bodyToBytes(init.body) : null;
          if (bytes) {
            const patched = patchSabrBody(bytes);
            if (patched) {
              init = Object.assign({}, init, { body: patched });
              console.log(TAG, 'SABR: wymuszono audio-only (', bytes.length, '->', patched.length, 'B )');
            } else {
              console.warn(TAG, 'SABR: nie udało się sparsować ciała żądania');
            }
          } else if (input instanceof Request && !(init && init.body)) {
            // Player woła fetch(new Request(...)) – ciało siedzi w Requeście.
            const req = input;
            return (async () => {
              let next = req;
              try {
                const buf = new Uint8Array(await req.clone().arrayBuffer());
                if (debug() && dumps < 3) {
                  dumps++;
                  console.log(TAG, 'SABR dump #' + dumps, dumpFields(buf, 2));
                }
                const patched = patchSabrBody(buf);
                if (patched) {
                  next = new Request(req, { body: patched });
                  console.log(TAG, 'SABR: wymuszono audio-only (Request,', buf.length, '->', patched.length, 'B )');
                } else {
                  console.warn(TAG, 'SABR: nie udało się sparsować ciała (Request), długość', buf.length);
                }
              } catch (e) { console.warn(TAG, 'SABR Request patch', e); }
              const res = await origFetch.call(window, next, init);
              if (debug()) {
                res.clone().arrayBuffer().then((ab) => {
                  try { console.log(TAG, 'SABR odpowiedź', JSON.stringify(analyzeUmp(new Uint8Array(ab)))); }
                  catch (e) { console.warn(TAG, 'analyzeUmp', e); }
                }).catch(() => {});
              }
              return res;
            })();
          } else if (!warnedRequestInput) {
            warnedRequestInput = true;
            console.warn(TAG, 'SABR: brak ciała do patchowania, init.body=' + (init && typeof init.body));
          }
        }
      }
    } catch (e) { console.warn(TAG, 'fetch hook', e); }
    return origFetch.call(this, input, init);
  };

  console.log(TAG, 'zainicjalizowano, enabled =', enabled());
})();
