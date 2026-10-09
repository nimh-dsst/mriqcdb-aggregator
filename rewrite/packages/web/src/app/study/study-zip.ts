const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x0605_4b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x0201_4b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x0403_4b50;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

interface CentralDirectoryEntry {
  readonly compressedSize: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly flags: number;
  readonly localHeaderOffset: number;
  readonly path: string;
  readonly uncompressedSize: number;
}

const crcTable = createCrcTable();

/**
 * Reads the file entries in a conventional single-disk ZIP archive.
 *
 * ZIP data descriptors are supported because sizes and CRCs are taken from
 * the central directory. ZIP64, encrypted archives, and compression methods
 * other than stored and DEFLATE are deliberately rejected.
 */
export async function unzipStudyArchive(
  bytes: Uint8Array,
): Promise<Record<string, Uint8Array>> {
  const endOfCentralDirectory = findEndOfCentralDirectory(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const diskNumber = readUint16(view, endOfCentralDirectory + 4);
  const centralDirectoryDisk = readUint16(view, endOfCentralDirectory + 6);
  const entriesOnThisDisk = readUint16(view, endOfCentralDirectory + 8);
  const entryCount = readUint16(view, endOfCentralDirectory + 10);
  const centralDirectorySize = readUint32(view, endOfCentralDirectory + 12);
  const centralDirectoryOffset = readUint32(view, endOfCentralDirectory + 16);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnThisDisk !== entryCount
  ) {
    throw invalidZip('multi-disk archives are unsupported');
  }

  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffff_ffff ||
    centralDirectoryOffset === 0xffff_ffff
  ) {
    throw invalidZip('ZIP64 archives are unsupported');
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryEnd > endOfCentralDirectory ||
    !isInBounds(bytes, centralDirectoryOffset, centralDirectorySize)
  ) {
    throw invalidZip('central directory is outside the archive');
  }

  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  const paths = new Set<string>();
  const entries: CentralDirectoryEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (!isInBounds(bytes, cursor, 46) || readUint32(view, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw invalidZip('central directory entry is truncated');
    }

    const flags = readUint16(view, cursor + 8);
    const compressionMethod = readUint16(view, cursor + 10);
    const crc32 = readUint32(view, cursor + 16);
    const compressedSize = readUint32(view, cursor + 20);
    const uncompressedSize = readUint32(view, cursor + 24);
    const nameLength = readUint16(view, cursor + 28);
    const extraLength = readUint16(view, cursor + 30);
    const commentLength = readUint16(view, cursor + 32);
    const localHeaderOffset = readUint32(view, cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;

    if (!isInBounds(bytes, cursor, entryLength) || cursor + entryLength > centralDirectoryEnd) {
      throw invalidZip('central directory entry exceeds its bounds');
    }

    if ((flags & 0x0041) !== 0) {
      throw invalidZip('encrypted entries are unsupported');
    }

    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw invalidZip(`unsupported compression method ${compressionMethod}`);
    }

    const nameStart = cursor + 46;
    const path = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (paths.has(path)) {
      throw invalidZip(`duplicate entry path ${JSON.stringify(path)}`);
    }
    paths.add(path);

    if (!path.endsWith('/')) {
      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw invalidZip('uncompressed data exceeds the 1 GiB safety limit');
      }

      entries.push({
        compressedSize,
        compressionMethod,
        crc32,
        flags,
        localHeaderOffset,
        path,
        uncompressedSize,
      });
    }

    cursor += entryLength;
  }

  const archive = Object.create(null) as Record<string, Uint8Array>;
  for (const entry of entries) {
    archive[entry.path] = await extractEntry(bytes, view, entry);
  }

  return archive;
}

async function extractEntry(
  bytes: Uint8Array,
  view: DataView,
  entry: CentralDirectoryEntry,
): Promise<Uint8Array> {
  if (
    !isInBounds(bytes, entry.localHeaderOffset, 30) ||
    readUint32(view, entry.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE
  ) {
    throw invalidZip(`local header for ${JSON.stringify(entry.path)} is missing`);
  }

  const localFlags = readUint16(view, entry.localHeaderOffset + 6);
  const localCompressionMethod = readUint16(view, entry.localHeaderOffset + 8);
  const localNameLength = readUint16(view, entry.localHeaderOffset + 26);
  const localExtraLength = readUint16(view, entry.localHeaderOffset + 28);
  if ((localFlags & 0x0041) !== 0) {
    throw invalidZip('encrypted entries are unsupported');
  }
  if (
    localCompressionMethod !== entry.compressionMethod ||
    (localFlags & 0x0008) !== (entry.flags & 0x0008)
  ) {
    throw invalidZip(`local header for ${JSON.stringify(entry.path)} disagrees with the central directory`);
  }

  const localNameOffset = entry.localHeaderOffset + 30;
  if (
    !isInBounds(bytes, localNameOffset, localNameLength) ||
    new TextDecoder().decode(bytes.subarray(localNameOffset, localNameOffset + localNameLength)) !==
      entry.path
  ) {
    throw invalidZip(`local header for ${JSON.stringify(entry.path)} has a different path`);
  }

  const dataOffset = localNameOffset + localNameLength + localExtraLength;
  if (!isInBounds(bytes, dataOffset, entry.compressedSize)) {
    throw invalidZip(`compressed data for ${JSON.stringify(entry.path)} is truncated`);
  }

  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
  let contents: Uint8Array;
  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw invalidZip(`stored entry ${JSON.stringify(entry.path)} has inconsistent sizes`);
    }
    contents = new Uint8Array(compressed);
  } else {
    contents = await decompressDeflateRaw(compressed, entry.uncompressedSize);
  }

  if (contents.byteLength !== entry.uncompressedSize) {
    throw invalidZip(`entry ${JSON.stringify(entry.path)} has an unexpected uncompressed size`);
  }
  if (crc32(contents) !== entry.crc32) {
    throw invalidZip(`entry ${JSON.stringify(entry.path)} failed its integrity check`);
  }

  return contents;
}

async function decompressDeflateRaw(
  compressed: Uint8Array,
  expectedSize: number,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw invalidZip('DEFLATE compression is unsupported by this browser');
  }

  try {
    const input = new Uint8Array(compressed.byteLength);
    input.set(compressed);
    const reader = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) { controller.enqueue(input); controller.close(); },
    })
      .pipeThrough(new DecompressionStream('deflate-raw'))
      .getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      totalSize += value.byteLength;
      if (totalSize > expectedSize) {
        await reader.cancel();
        throw invalidZip('DEFLATE data exceeds its declared size');
      }
      chunks.push(value);
    }

    const contents = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      contents.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return contents;
  } catch {
    throw invalidZip('DEFLATE data is corrupt or unsupported by this browser');
  }
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  if (bytes.byteLength < 22) {
    throw invalidZip('end of central directory is missing');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (
      readUint32(view, offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
      offset + 22 + readUint16(view, offset + 20) === bytes.byteLength
    ) {
      return offset;
    }
  }

  throw invalidZip('end of central directory is missing');
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb8_8320;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]!;
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function isInBounds(bytes: Uint8Array, offset: number, length: number): boolean {
  return offset >= 0 && length >= 0 && offset <= bytes.byteLength - length;
}

function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function invalidZip(message: string): Error {
  return new Error(`Invalid ZIP archive: ${message}.`);
}
