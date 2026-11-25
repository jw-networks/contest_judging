/*
 * Minimal QR code generator for Spotlight's sign-up links (byte mode, error correction level M, versions 1–10,
 * i.e. up to 213 bytes). Works offline, no outside service. Follows ISO/IEC 18004; structure after Project
 * Nayuki's QR Code generator (MIT).
 *   qrMatrix(text) -> array of rows of booleans (true = dark)
 *   qrSvg(text, { margin, size }) -> SVG markup
 */
(function () {
  // Per version at level M: [error-correction codewords per block, [blocks, data codewords] per group…]
  const TABLE = [null,
    [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]],
    [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // GF(256) arithmetic, primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  function rsRemainder(data, degree) {
    let gen = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); }
      gen = next;
    }
    const r = [...data, ...new Array(degree).fill(0)];
    for (let i = 0; i < data.length; i++) {
      const c = r[i];
      if (c) for (let j = 0; j < gen.length; j++) r[i + j] ^= mul(gen[j], c);
    }
    return r.slice(data.length);
  }

  function qrMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 0;
    for (let v = 1; v <= 10; v++) {
      const dataCw = TABLE[v].slice(1).reduce((s, [n, d]) => s + n * d, 0);
      if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCw * 8) { ver = v; break; }
    }
    if (!ver) throw new Error('Text too long for a QR code');
    const [ecLen, ...groups] = TABLE[ver];
    const dataCw = groups.reduce((s, [n, d]) => s + n * d, 0);

    // bit stream: mode (byte), length, data, terminator, padding
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, dataCw * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) cw.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let pad = 0xec; cw.length < dataCw; pad ^= 0xec ^ 0x11) cw.push(pad);

    // split into blocks, add error correction, interleave
    const blocks = [];
    let k = 0;
    for (const [n, d] of groups) for (let i = 0; i < n; i++) { const data = cw.slice(k, k + d); k += d; blocks.push({ data, ec: rsRemainder(data, ecLen) }); }
    const out = [];
    const maxData = Math.max(...blocks.map(b => b.data.length));
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);

    // matrix + which modules are fixed patterns
    const size = 17 + 4 * ver;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = ALIGN[ver], last = al.length - 1;
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = mask => {
      const data = (0 << 3) | mask; // level M = 00
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((data << 10) | rem) ^ 0x5412;
      const bit = i => ((b >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true); // always-dark module
    };
    drawFormat(0); // reserve the area
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) { const dark = ((b >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, dark); set(c, a, dark); }
    }

    // data, in the zigzag order
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < out.length * 8) { m[y][x] = ((out[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
      }
    }

    // try the 8 masks, keep the one with the lowest penalty
    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
    const applyMask = mk => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mk](x, y)) m[y][x] = !m[y][x]; };
    const penalty = () => {
      let p = 0;
      const lines = [];
      for (let y = 0; y < size; y++) lines.push(m[y]);
      for (let x = 0; x < size; x++) lines.push(m.map(r => r[x]));
      const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0].join(''), pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1].join('');
      for (const line of lines) {
        let run = 1;
        for (let k2 = 1; k2 <= size; k2++) {
          if (k2 < size && line[k2] === line[k2 - 1]) run++;
          else { if (run >= 5) p += 3 + run - 5; run = 1; }
        }
        const s = line.map(v => (v ? 1 : 0)).join('');
        for (let k2 = s.indexOf(pat1); k2 >= 0; k2 = s.indexOf(pat1, k2 + 1)) p += 40;
        for (let k2 = s.indexOf(pat2); k2 >= 0; k2 = s.indexOf(pat2, k2 + 1)) p += 40;
      }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
      }
      const dark = m.reduce((s, r) => s + r.filter(Boolean).length, 0), total = size * size;
      p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return p;
    };
    let best = 0, bestP = Infinity;
    for (let mk = 0; mk < 8; mk++) {
      applyMask(mk); drawFormat(mk);
      const p = penalty();
      if (p < bestP) { best = mk; bestP = p; }
      applyMask(mk); // undo
    }
    applyMask(best); drawFormat(best);
    return m;
  }

  function qrSvg(text, { margin = 4, size = 256, dark = '#000', light = '#fff' } = {}) {
    const m = qrMatrix(text), n = m.length + margin * 2;
    let d = '';
    m.forEach((row, y) => row.forEach((v, x) => { if (v) d += `M${x + margin},${y + margin}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
  }

  const api = { qrMatrix, qrSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(globalThis, api);
})();
