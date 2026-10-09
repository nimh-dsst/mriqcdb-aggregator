import { deflateRawSync } from 'node:zlib';

export interface ZipFixtureEntry {
  readonly centralExtra?: Uint8Array;
  readonly compressionMethod?: number;
  readonly contents?: string | Uint8Array;
  readonly dataDescriptor?: boolean;
  readonly directory?: boolean;
  readonly flags?: number;
  readonly localExtra?: Uint8Array;
  readonly path: string;
}

export function createZip(
  entries: readonly ZipFixtureEntry[],
  options: { readonly comment?: string } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const localRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const path = entry.directory && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path;
    const name = encoder.encode(path);
    const contents = toBytes(entry.contents, encoder);
    const compressionMethod = entry.compressionMethod ?? 0;
    const compressed =
      compressionMethod === 8
        ? new Uint8Array(deflateRawSync(contents))
        : new Uint8Array(contents);
    const flags = (entry.flags ?? 0) | (entry.dataDescriptor ? 0x0008 : 0);
    const localExtra = entry.localExtra ?? new Uint8Array();
    const centralExtra = entry.centralExtra ?? new Uint8Array();
    const checksum = crc32(contents);
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x0403_4b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, compressionMethod, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.dataDescriptor ? 0 : compressed.byteLength, true);
    localView.setUint32(22, entry.dataDescriptor ? 0 : contents.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    localView.setUint16(28, localExtra.byteLength, true);

    const descriptor = entry.dataDescriptor
      ? dataDescriptor(checksum, compressed.byteLength, contents.byteLength)
      : new Uint8Array();
    const localRecord = join([localHeader, name, localExtra, compressed, descriptor]);
    localRecords.push(localRecord);

    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x0201_4b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, compressionMethod, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, contents.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint16(30, centralExtra.byteLength, true);
    centralView.setUint32(38, entry.directory ? 0x10 : 0, true);
    centralView.setUint32(42, localOffset, true);
    centralRecords.push(join([centralHeader, name, centralExtra]));
    localOffset += localRecord.byteLength;
  }

  const localData = join(localRecords);
  const centralDirectory = join(centralRecords);
  const comment = encoder.encode(options.comment ?? '');
  const endOfCentralDirectory = new Uint8Array(22);
  const endView = new DataView(endOfCentralDirectory.buffer);
  endView.setUint32(0, 0x0605_4b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.byteLength, true);
  endView.setUint32(16, localData.byteLength, true);
  endView.setUint16(20, comment.byteLength, true);

  return join([localData, centralDirectory, endOfCentralDirectory, comment]);
}

function dataDescriptor(
  checksum: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  const descriptor = new Uint8Array(16);
  const view = new DataView(descriptor.buffer);
  view.setUint32(0, 0x0807_4b50, true);
  view.setUint32(4, checksum, true);
  view.setUint32(8, compressedSize, true);
  view.setUint32(12, uncompressedSize, true);
  return descriptor;
}

function toBytes(contents: string | Uint8Array | undefined, encoder: TextEncoder): Uint8Array {
  if (typeof contents === 'string') {
    return encoder.encode(contents);
  }
  return contents === undefined ? new Uint8Array() : new Uint8Array(contents);
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb8_8320;
    }
  }
  return (value ^ 0xffff_ffff) >>> 0;
}
