import { SchemaError } from '../connector';

// Upload safety (E4.2). An .xlsx file is a zip archive, and a small archive can expand to gigabytes
// (a "zip bomb"). The central directory states every entry's uncompressed size, so the totals are
// checked here before any byte is decompressed.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

export function assertSafeXlsx(file: Buffer): void {
  if (file.length < 22 || file.readUInt32LE(0) !== 0x04034b50)
    throw new SchemaError('the file is not an .xlsx workbook');
  if (file.length > MAX_UPLOAD_BYTES) throw new SchemaError('the file is too large');

  // The end-of-central-directory record sits in the last 22 + 65535 bytes.
  let eocd = -1;
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 65_535); i--) {
    if (file.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SchemaError('the file is not an .xlsx workbook');
  const entries = file.readUInt16LE(eocd + 10);
  const directoryOffset = file.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directoryOffset === 0xffffffff)
    throw new SchemaError('the archive uses an unsupported format');
  if (entries > MAX_ENTRIES) throw new SchemaError('the archive has too many entries');

  let offset = directoryOffset;
  let total = 0;
  const names = new Set<string>();
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > file.length || file.readUInt32LE(offset) !== CENTRAL_SIGNATURE)
      throw new SchemaError('the file is not an .xlsx workbook');
    const uncompressed = file.readUInt32LE(offset + 24);
    const nameLength = file.readUInt16LE(offset + 28);
    const extraLength = file.readUInt16LE(offset + 30);
    const commentLength = file.readUInt16LE(offset + 32);
    if (uncompressed === 0xffffffff)
      throw new SchemaError('the archive uses an unsupported format');
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new SchemaError('the archive expands too much');
    names.add(file.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml'))
    throw new SchemaError('the file is not an .xlsx workbook');
}
