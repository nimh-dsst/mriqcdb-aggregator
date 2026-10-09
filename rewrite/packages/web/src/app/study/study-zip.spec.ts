import { describe, expect, it } from 'vitest';

import { createZip } from './study-zip.fixtures';
import { unzipStudyArchive } from './study-zip';

describe('unzipStudyArchive', () => {
  it('reads stored and DEFLATE entries with data descriptors and ZIP metadata', async () => {
    const bytes = createZip(
      [
        {
          directory: true,
          localExtra: new Uint8Array([0xfe, 0xca, 0x02, 0x00, 0x01, 0x02]),
          path: 'scans',
        },
        {
          centralExtra: new Uint8Array([0xfe, 0xca, 0x02, 0x00, 0x03, 0x04]),
          contents: '{"kind":"stored"}',
          localExtra: new Uint8Array([0xfe, 0xca, 0x02, 0x00, 0x05, 0x06]),
          path: 'scans/stored.json',
        },
        {
          compressionMethod: 8,
          contents: '{"kind":"deflated"}',
          dataDescriptor: true,
          path: 'scans/deflated.json',
        },
      ],
      { comment: 'fixture archive comment' },
    );

    const archive = await unzipStudyArchive(bytes);

    expect(Object.keys(archive).sort()).toEqual([
      'scans/deflated.json',
      'scans/stored.json',
    ]);
    expect(new TextDecoder().decode(archive['scans/stored.json'])).toBe('{"kind":"stored"}');
    expect(new TextDecoder().decode(archive['scans/deflated.json'])).toBe('{"kind":"deflated"}');
  });

  it('rejects a stored entry whose bytes do not match its CRC', async () => {
    const bytes = createZip([{ contents: '{"valid":true}', path: 'report.json' }]);
    bytes[30 + 'report.json'.length] ^= 0x01;

    await expect(unzipStudyArchive(bytes)).rejects.toThrow(/integrity check/i);
  });

  it('rejects unsupported compression and encrypted entries', async () => {
    await expect(
      unzipStudyArchive(
        createZip([{ compressionMethod: 12, contents: 'data', path: 'unsupported.bin' }]),
      ),
    ).rejects.toThrow(/unsupported compression/i);

    await expect(
      unzipStudyArchive(createZip([{ contents: 'data', flags: 0x0001, path: 'encrypted.bin' }])),
    ).rejects.toThrow(/encrypted/i);
  });

  it('rejects a truncated archive before attempting extraction', async () => {
    const bytes = createZip([{ contents: 'data', path: 'report.json' }]);

    await expect(unzipStudyArchive(bytes.subarray(0, bytes.byteLength - 3))).rejects.toThrow(
      /end of central directory/i,
    );
  });
});
