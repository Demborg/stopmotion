const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_BYTES = 22;
const ZIP_VERSION_2_0 = 20;
const CRC32_POLYNOMIAL = 0xedb88320;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const dosTime = (d) => (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
const dosDate = (d) => ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

function header(bytes, fields) {
  const view = new DataView(new ArrayBuffer(bytes));
  for (const [offset, value, width] of fields) {
    if (width === 4) view.setUint32(offset, value, true);
    else view.setUint16(offset, value, true);
  }
  return view;
}

export async function makeUncompressedZip(entries) {
  const now = new Date();
  const time = dosTime(now);
  const date = dosDate(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, file } of entries) {
    const crc = crc32(new Uint8Array(await file.arrayBuffer()));
    const nameBytes = new TextEncoder().encode(name);
    const size = file.size;
    localParts.push(header(LOCAL_HEADER_BYTES, [
      [0, LOCAL_HEADER_SIGNATURE, 4], [4, ZIP_VERSION_2_0], [10, time], [12, date],
      [14, crc, 4], [18, size, 4], [22, size, 4], [26, nameBytes.length],
    ]), nameBytes, file);
    centralParts.push(header(CENTRAL_HEADER_BYTES, [
      [0, CENTRAL_HEADER_SIGNATURE, 4], [4, ZIP_VERSION_2_0], [6, ZIP_VERSION_2_0], [12, time], [14, date],
      [16, crc, 4], [20, size, 4], [24, size, 4], [28, nameBytes.length], [42, offset, 4],
    ]), nameBytes);
    offset += LOCAL_HEADER_BYTES + nameBytes.length + size;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = header(END_OF_CENTRAL_BYTES, [
    [0, END_OF_CENTRAL_SIGNATURE, 4], [8, entries.length], [10, entries.length],
    [12, centralSize, 4], [16, offset, 4],
  ]);
  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}
