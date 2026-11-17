// Minimal ZIP reader/writer for backups. Writing stores files uncompressed
// (photos and PDFs are already compressed) and never copies them into memory:
// the result is a Blob stitched together from the original file Blobs.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const CHUNK = 4 << 20;

async function crc32(blob) {
  let c = 0xffffffff;
  for (let off = 0; off < blob.size; off += CHUNK) {
    const buf = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ name: 'files/a.jpg', blob: Blob }]
export async function zipBlob(entries, onProgress) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  let done = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = await crc32(e.blob);
    const size = e.blob.size;
    if (size > 0xfffffffe || offset > 0xfffffffe) throw new Error('backup-too-large');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // names are UTF-8
    lh.setUint16(8, 0, true); // stored
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, e.blob);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);

    offset += 30 + name.length + size;
    if (onProgress) onProgress(++done, entries.length);
  }
  if (entries.length > 0xfffe) throw new Error('backup-too-large');
  const cdSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// Returns [{ name, size, blob(): Promise<Blob> }]. Handles stored and deflated
// entries, so a backup that was unpacked and re-zipped on a computer still opens.
export async function unzip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not-zip');
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOffset = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('not-zip');
    const method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true);
    const usize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const local = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    out.push({
      name,
      size: usize,
      async blob() {
        const lh = new DataView(await file.slice(local, local + 30).arrayBuffer());
        const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const data = file.slice(start, start + csize);
        if (method === 0) return data;
        if (method === 8) {
          const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
          return new Response(stream).blob();
        }
        throw new Error('zip-method-' + method);
      },
    });
  }
  return out;
}
