// AudioTube – runs in the page's MAIN world at document_start.
//
// Two mechanisms make YouTube play audio without downloading video:
//
// 1. SABR request patch. The web player streams media with SABR: a POST to
//    googlevideo.com/videoplayback?...&sabr=1 whose body is a protobuf
//    VideoPlaybackAbrRequest. Its ClientAbrState (field 1) carries
//    enabled_track_types_bitfield (field 40; observed value 3 = audio|video).
//    Setting it to 1 makes the server send audio segments only.
//    Field numbers are reverse-engineered, not an official schema.
//
// 2. Fake video SourceBuffer. The player still believes it is playing video,
//    so it creates a video SourceBuffer. We hand it a stub that accepts and
//    discards data and reports the whole duration as buffered, so the player
//    neither stalls nor errors out while waiting for video.
(() => {
  'use strict';

  const TAG = '[AudioTube]';

  const readFlag = (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === '1';
    } catch {
      return fallback;
    }
  };
  // Kept in sync with chrome.storage by bridge.js.
  const enabled = () => readFlag('audiotube_enabled', true);
  // Set localStorage.audiotube_debug = '1' in the page console and reload.
  const debug = () => readFlag('audiotube_debug', false);

  const warned = new Set();
  const warnOnce = (msg, ...rest) => {
    if (warned.has(msg)) return;
    warned.add(msg);
    console.warn(TAG, msg, ...rest);
  };

  if (!window.MediaSource) return;

  // ---------------------------------------------------------------------------
  // Fake video SourceBuffer
  // ---------------------------------------------------------------------------

  const HANDLER_EVENTS = ['abort', 'error', 'update', 'updateend', 'updatestart'];

  class FakeSourceBuffer extends EventTarget {
    constructor(mediaSource) {
      super();
      this._mediaSource = mediaSource;
      this._updating = false;
      this._handlers = {};
      this.mode = 'segments';
      this.timestampOffset = 0;
      this.appendWindowStart = 0;
      this.appendWindowEnd = Infinity;
    }

    get updating() {
      return this._updating;
    }

    // Report [0, duration] as buffered. Empty when duration is not finite
    // (e.g. live streams).
    get buffered() {
      const d = this._mediaSource.duration;
      const end = Number.isFinite(d) && d > 0 ? d : 0;
      const check = (i) => {
        if (i !== 0 || !end) throw new DOMException('Index out of range', 'IndexSizeError');
      };
      return {
        length: end ? 1 : 0,
        start: (i) => (check(i), 0),
        end: (i) => (check(i), end),
      };
    }

    _completeAsync() {
      this._updating = true;
      this.dispatchEvent(new Event('updatestart'));
      setTimeout(() => {
        this._updating = false;
        this.dispatchEvent(new Event('update'));
        this.dispatchEvent(new Event('updateend'));
      }, 0);
    }

    appendBuffer() { this._completeAsync(); }
    remove() { this._completeAsync(); }
    abort() { this._updating = false; }
    changeType() {}
  }

  // onupdateend & co. as accessors wired to addEventListener.
  for (const evt of HANDLER_EVENTS) {
    Object.defineProperty(FakeSourceBuffer.prototype, 'on' + evt, {
      get() { return this._handlers[evt] || null; },
      set(fn) {
        if (this._handlers[evt]) this.removeEventListener(evt, this._handlers[evt]);
        this._handlers[evt] = typeof fn === 'function' ? fn : null;
        if (this._handlers[evt]) this.addEventListener(evt, this._handlers[evt]);
      },
    });
  }

  const nativeAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (type) {
    if (enabled() && typeof type === 'string' && /^video\//i.test(type)) {
      if (debug()) console.log(TAG, 'fake SourceBuffer for', type);
      return new FakeSourceBuffer(this);
    }
    return nativeAddSourceBuffer.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // Minimal protobuf reader/writer
  // ---------------------------------------------------------------------------

  // Returns [value, nextPos] or null. Values above 2^53 lose precision, which
  // is fine: we only interpret tags, lengths and small enums.
  function readVarint(buf, pos) {
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      if (pos >= buf.length) return null;
      const b = buf[pos++];
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return [value, pos];
    }
    return null;
  }

  function writeVarint(n) {
    const out = [];
    while (n >= 0x80) {
      out.push((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    out.push(n);
    return Uint8Array.from(out);
  }

  // Splits a message into fields without decoding values.
  // Each field: { num, wire, start, end, dataStart, dataEnd }. null on error.
  function parseFields(buf) {
    const fields = [];
    let pos = 0;
    while (pos < buf.length) {
      const start = pos;
      const tag = readVarint(buf, pos);
      if (!tag) return null;
      pos = tag[1];
      const num = Math.floor(tag[0] / 8);
      const wire = tag[0] % 8;
      let dataStart = pos;
      let dataEnd;
      if (wire === 0) {
        const v = readVarint(buf, pos);
        if (!v) return null;
        dataEnd = v[1];
      } else if (wire === 1) {
        dataEnd = pos + 8;
      } else if (wire === 5) {
        dataEnd = pos + 4;
      } else if (wire === 2) {
        const len = readVarint(buf, pos);
        if (!len) return null;
        dataStart = len[1];
        dataEnd = dataStart + len[0];
      } else {
        return null; // groups are not used by this message
      }
      if (dataEnd > buf.length) return null;
      fields.push({ num, wire, start, end: dataEnd, dataStart, dataEnd });
      pos = dataEnd;
    }
    return fields;
  }

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // SABR request patch
  // ---------------------------------------------------------------------------

  const CLIENT_ABR_STATE = 1;
  const ENABLED_TRACK_TYPES = 40;
  const TRACK_TYPES_AUDIO_ONLY = 1;
  // Tag (field 40, wire type 0) followed by the value.
  const ENABLED_TRACK_TYPES_FIELD = concat([writeVarint(ENABLED_TRACK_TYPES * 8), [TRACK_TYPES_AUDIO_ONLY]]);

  // Returns a patched copy of a VideoPlaybackAbrRequest body, or null if it
  // cannot be parsed.
  function patchSabrBody(bytes) {
    const top = parseFields(bytes);
    if (!top) return null;

    const abr = top.find((f) => f.num === CLIENT_ABR_STATE && f.wire === 2);
    if (!abr) {
      // No ClientAbrState at all – prepend one holding only our field.
      return concat([
        writeVarint(CLIENT_ABR_STATE * 8 + 2),
        writeVarint(ENABLED_TRACK_TYPES_FIELD.length),
        ENABLED_TRACK_TYPES_FIELD,
        bytes,
      ]);
    }

    const inner = bytes.subarray(abr.dataStart, abr.dataEnd);
    const fields = parseFields(inner);
    if (!fields) return null;

    const isTrackTypes = (f) => f.num === ENABLED_TRACK_TYPES && f.wire === 0;
    const existing = fields.find(isTrackTypes);

    // Common case: overwrite the single value byte in place. Size-preserving.
    if (existing && existing.dataEnd - existing.dataStart === 1) {
      const out = bytes.slice();
      out[abr.dataStart + existing.dataStart] = TRACK_TYPES_AUDIO_ONLY;
      return out;
    }

    // Otherwise rebuild ClientAbrState with the field replaced or appended.
    const newInner = concat([
      ...fields.filter((f) => !isTrackTypes(f)).map((f) => inner.subarray(f.start, f.end)),
      ENABLED_TRACK_TYPES_FIELD,
    ]);
    return concat([
      bytes.subarray(0, abr.start),
      writeVarint(CLIENT_ABR_STATE * 8 + 2),
      writeVarint(newInner.length),
      newInner,
      bytes.subarray(abr.end),
    ]);
  }

  function toBytes(body) {
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return null;
  }

  function isSabrRequest(input) {
    try {
      const raw = input instanceof Request ? input.url : String(input);
      if (!raw.includes('/videoplayback')) return false;
      return new URL(raw, location.href).searchParams.get('sabr') === '1';
    } catch {
      return false;
    }
  }

  const nativeFetch = window.fetch;

  async function fetchPatched(input, init) {
    let request = input;
    let options = init;
    try {
      if (options && options.body != null) {
        const bytes = toBytes(options.body);
        const patched = bytes && patchSabrBody(bytes);
        if (patched) {
          debugDumpRequest(bytes);
          options = { ...options, body: patched };
        } else {
          warnOnce('Could not patch SABR request body; video may still be downloaded.');
        }
      } else if (input instanceof Request) {
        const bytes = new Uint8Array(await input.clone().arrayBuffer());
        const patched = patchSabrBody(bytes);
        if (patched) {
          debugDumpRequest(bytes);
          request = new Request(input, { body: patched });
        } else {
          warnOnce('Could not patch SABR request body; video may still be downloaded.');
        }
      }
    } catch (e) {
      warnOnce('SABR patch failed; video may still be downloaded.', e);
    }

    const response = await nativeFetch.call(window, request, options);
    if (debug()) debugLogResponse(response);
    return response;
  }

  window.fetch = function (input, init) {
    if (enabled() && isSabrRequest(input)) return fetchPatched(input, init);
    return nativeFetch.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // Debug helpers (only active with localStorage.audiotube_debug = '1')
  // ---------------------------------------------------------------------------

  // Compact structural dump of a protobuf message, e.g. "1:{18=1042,40=3},5:len80".
  // Nested messages are detected heuristically.
  function dumpFields(buf, depth) {
    const fields = parseFields(buf);
    if (!fields) return null;
    return fields.map((f) => {
      if (f.wire === 0) return f.num + '=' + readVarint(buf, f.dataStart)[0];
      if (f.wire === 2) {
        const sub = buf.subarray(f.dataStart, f.dataEnd);
        const nested = depth > 0 && sub.length ? dumpFields(sub, depth - 1) : null;
        return f.num + (nested ? ':{' + nested + '}' : ':len' + sub.length);
      }
      return f.num + '~w' + f.wire;
    }).join(',');
  }

  let requestDumps = 0;
  function debugDumpRequest(bytes) {
    if (!debug() || requestDumps >= 3) return;
    requestDumps++;
    console.log(TAG, 'SABR request #' + requestDumps, dumpFields(bytes, 2));
  }

  // UMP (the SABR response framing) uses its own varint: the leading bits of
  // the first byte give the total length (1–5 bytes).
  function readUmpVarint(buf, pos) {
    if (pos >= buf.length) return null;
    const b0 = buf[pos];
    const size = b0 < 0x80 ? 1 : b0 < 0xc0 ? 2 : b0 < 0xe0 ? 3 : b0 < 0xf0 ? 4 : 5;
    if (pos + size > buf.length) return null;
    let value;
    if (size === 1) {
      value = b0;
    } else if (size === 5) {
      value = (buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16) | (buf[pos + 4] << 24)) >>> 0;
    } else {
      value = b0 & ((1 << (8 - size)) - 1);
      let shift = 8 - size;
      for (let i = 1; i < size; i++, shift += 8) value += buf[pos + i] * 2 ** shift;
    }
    return [value, pos + size];
  }

  const UMP_MEDIA_HEADER = 20; // protobuf: 1 = header_id, 3 = itag
  const UMP_MEDIA = 21; // first byte = header_id, rest = media data

  // Summarises a UMP response: total size, media bytes per itag, part counts.
  function analyzeUmp(buf) {
    const itagByHeader = {};
    const bytesByItag = {};
    const partCounts = {};
    let pos = 0;
    while (pos < buf.length) {
      const type = readUmpVarint(buf, pos);
      if (!type) break;
      const size = readUmpVarint(buf, type[1]);
      if (!size) break;
      const payload = buf.subarray(size[1], size[1] + size[0]);
      partCounts[type[0]] = (partCounts[type[0]] || 0) + 1;
      if (type[0] === UMP_MEDIA_HEADER) {
        const fields = parseFields(payload) || [];
        const id = fields.find((f) => f.num === 1 && f.wire === 0);
        const itag = fields.find((f) => f.num === 3 && f.wire === 0);
        if (id && itag) {
          itagByHeader[readVarint(payload, id.dataStart)[0]] = readVarint(payload, itag.dataStart)[0];
        }
      } else if (type[0] === UMP_MEDIA && payload.length) {
        const itag = itagByHeader[payload[0]];
        bytesByItag[itag] = (bytesByItag[itag] || 0) + payload.length - 1;
      }
      pos = size[1] + size[0];
    }
    return { total: buf.length, bytesByItag, partCounts };
  }

  function debugLogResponse(response) {
    response.clone().arrayBuffer()
      .then((ab) => console.log(TAG, 'SABR response', JSON.stringify(analyzeUmp(new Uint8Array(ab)))))
      .catch(() => {});
  }

  if (debug()) console.log(TAG, 'initialised, enabled =', enabled());
})();
