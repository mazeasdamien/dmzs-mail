/**
 * A streaming ZIP writer, stored (uncompressed).
 *
 * Built rather than pulled in because a Worker has a hard memory ceiling and
 * every zip library wants the whole archive in hand. This one streams: each
 * entry is fetched, written and released before the next begins, so peak
 * memory is one attachment rather than the whole message.
 *
 * Stored, not deflated, on purpose. The attachments that make a message big
 * are JPEGs and MOVs — already compressed, so deflate would burn CPU (the
 * scarce resource here) to save nothing.
 *
 * Sizes and CRCs go in each local header, not in a trailing data descriptor.
 * Streaming normally forces the descriptor form — you must emit the header
 * before you know the content — but here each entry is fully in hand when its
 * header is written, so the honest sizes can go in. Windows Explorer reads
 * descriptor-form archives poorly, and "the zip opens empty" is the worst kind
 * of bug: it looks like the data was never there.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true); // ZIP is little-endian throughout
  return b;
};
const u16 = (n) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return b;
};
const join = (...chunks) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/** Duplicate names would silently overwrite on extraction, so they get a suffix. */
function uniqueNames(names) {
  const seen = new Map();
  return names.map((raw) => {
    const name = String(raw || "file").replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 180) || "file";
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n === 1) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
  });
}

/**
 * entries: [{ name }], and load(entry, index) → Uint8Array.
 * Returns a ReadableStream of the finished archive.
 *
 * An entry whose load() throws is skipped rather than aborting the archive:
 * ten good attachments should not be lost to one unreadable one.
 */
export function zipStream(entries, load, onFinish) {
  const names = uniqueNames(entries.map((e) => e.name));
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      // onFinish runs when the last byte is written — never before. Whatever
      // `load` reads from (an IMAP connection here) has to outlive every pull,
      // and closing it early yields a technically valid, entirely empty
      // archive: each load throws, each entry is skipped, and the reader sees
      // a zip containing nothing.
      try {
      const central = [];
      let offset = 0;
      const push = (bytes) => {
        controller.enqueue(bytes);
        offset += bytes.length;
      };

      for (let i = 0; i < entries.length; i++) {
        let data;
        try {
          data = await load(entries[i], i);
        } catch {
          continue;
        }
        if (!data) continue;

        const nameBytes = encoder.encode(names[i]);
        const localAt = offset;
        const crc = crc32(data);
        push(
          join(
            u32(0x04034b50),
            u16(20), // version needed
            u16(0x0800), // bit 11 only: names are UTF-8, sizes are known
            u16(0), // stored
            u16(0), // mod time — zeroed rather than faked
            u16(0x21), // mod date: 1 Jan 1980, the epoch ZIP was born with
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(nameBytes.length),
            u16(0),
            nameBytes
          )
        );
        push(data);

        central.push(
          join(
            u32(0x02014b50),
            u16(20),
            u16(20),
            u16(0x0800),
            u16(0),
            u16(0),
            u16(0x21),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(nameBytes.length),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(0),
            u32(localAt),
            nameBytes
          )
        );
      }

      const dirAt = offset;
      for (const c of central) push(c);
      push(
        join(
          u32(0x06054b50),
          u16(0),
          u16(0),
          u16(central.length),
          u16(central.length),
          u32(offset - dirAt),
          u32(dirAt),
          u16(0)
        )
      );
      controller.close();
      } finally {
        try {
          await onFinish?.();
        } catch {
          /* cleanup failing must not corrupt an archive already written */
        }
      }
    },
  });
}
