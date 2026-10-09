import { strToU8, zipSync } from 'fflate';
import {
  flattenStudyJson,
  normalizeStudy,
  parseDelimitedRows,
  parseStudyFile,
} from './study-parser';

const smallStudy = `bids_name,cjv,efc,bids_meta.Manufacturer,unused_note
sub-01_T1w,0.41,0.52,Siemens,"first, scan"
sub-02_T1w,0.62,0.73,GE,second scan
`;
const messyHeaders = `BIDS_NAME\t bids_meta.EchoTime \techo_time\tbids_meta.Modality__altcase1\tprovenance.version\tUnknown Column
sub-01_bold\t0.03\t99\tbold\t24.0.0\tignored value
`;

describe('study parsing', () => {
  it('parses quoted delimiters, escaped quotes, and newlines', () => {
    expect(parseDelimitedRows('a,b\r\n"x,y","say ""hi"""\n"two\nlines",z', ',')).toEqual([
      ['a', 'b'],
      ['x,y', 'say "hi"'],
      ['two\nlines', 'z'],
    ]);
  });

  it('normalizes CSV headers, coerces metrics, and reports unknown columns', async () => {
    const parsed = await parseStudyFile(new File([smallStudy], 'small-study.csv'));

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      bids_name: 'sub-01_T1w',
      cjv: 0.41,
      efc: 0.52,
      manufacturer: 'Siemens',
    });
    expect(parsed.metrics).toEqual(expect.arrayContaining(['cjv', 'efc']));
    expect(parsed.ignoredColumns).toEqual(['unused_note']);
    expect(parsed.missingMetrics).not.toContain('cjv');
  });

  it('keeps the first normalized duplicate and deterministically ignores later aliases', async () => {
    const parsed = await parseStudyFile(new File([messyHeaders], 'messy-headers.tsv'));

    expect(parsed.rows[0]).toMatchObject({
      bids_name: 'sub-01_bold',
      echo_time: 0.03,
      provenance_version: '24.0.0',
    });
    expect(parsed.ignoredColumns).toEqual([
      'echo_time',
      'bids_meta.Modality__altcase1',
      'Unknown Column',
    ]);
  });

  it('recursively flattens JSON while scalarizing arrays', () => {
    expect(
      flattenStudyJson({
        bids_meta: { EchoTime: 0.03, ImageType: ['ORIGINAL', 'PRIMARY'] },
        provenance: { settings: { fd_thres: 0.2 } },
      }),
    ).toEqual({
      'bids_meta.EchoTime': 0.03,
      'bids_meta.ImageType': '["ORIGINAL","PRIMARY"]',
      'provenance.settings.fd_thres': 0.2,
    });
  });

  it('loads sorted per-scan JSON paths from zip and derives a missing bids_name', async () => {
    const zip = zipSync({
      'scans/z.json': strToU8(JSON.stringify({ cjv: 0.8, provenance: { version: '24' } })),
      'scans/a.json': strToU8(JSON.stringify({ bids_name: 'named', cjv: 0.4 })),
      'notes.txt': strToU8('ignored'),
    });
    const parsed = await parseStudyFile(new File([zip], 'study.zip'));

    expect(parsed.rows.map((row) => row['bids_name'])).toEqual(['named', 'z']);
    expect(parsed.rows.map((row) => row['cjv'])).toEqual([0.4, 0.8]);
  });

  it('requires bids_name in a delimited table', () => {
    expect(() => normalizeStudy({ columns: ['cjv'], rows: [[0.4]] })).toThrowError(
      'The study needs a bids_name column',
    );
  });
});
