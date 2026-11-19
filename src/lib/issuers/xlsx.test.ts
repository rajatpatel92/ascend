import { describe, test } from 'node:test';
import assert from 'node:assert';
import { deflateRawSync } from 'node:zlib';
import { extractZipEntries, parseXlsxFirstSheet } from './xlsx.ts';

function buildMinimalZip(files: Array<{ name: string; content: Buffer; store?: boolean }>): Buffer {
    const localChunks: Buffer[] = [];
    const centralChunks: Buffer[] = [];
    let offset = 0;

    for (const file of files) {
        const nameBuf = Buffer.from(file.name, 'utf8');
        const method = file.store ? 0 : 8;
        const compressed = file.store ? file.content : deflateRawSync(file.content);

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(file.content.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        nameBuf.copy(local, 30);

        localChunks.push(local, compressed);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(file.content.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);
        centralChunks.push(central);

        offset += local.length + compressed.length;
    }

    const centralDir = Buffer.concat(centralChunks);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localChunks, centralDir, eocd]);
}

describe('parseXlsxFirstSheet', () => {
    test('parses deflated and stored XLSX entries with sharedStrings rich text, inlineStr, sparse columns, and entities', () => {
        const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Holdings" sheetId="1" r:id="rId2"/>
  </sheets>
</workbook>`;

        const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/holdings.xml"/>
</Relationships>`;

        const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
  <si><t>Name</t></si>
  <si><t>ISIN</t></si>
  <si><r><t>Weight </t></r><r><t>(%)</t></r></si>
  <si><t>AT&amp;T Inc &lt;US&gt;</t></si>
</sst>`;

        const sheetXml = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="D1" t="s"><v>2</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>3</v></c>
      <c r="B2" t="inlineStr"><is><t>US00206R1023</t></is></c>
      <c r="C2"/>
      <c r="D2"><v>4.25</v></c>
    </row>
  </sheetData>
</worksheet>`;

        const zipBuffer = buildMinimalZip([
            { name: 'xl/workbook.xml', content: Buffer.from(workbookXml, 'utf8'), store: true },
            { name: 'xl/_rels/workbook.xml.rels', content: Buffer.from(relsXml, 'utf8') },
            { name: 'xl/sharedStrings.xml', content: Buffer.from(sharedStringsXml, 'utf8') },
            { name: 'xl/worksheets/holdings.xml', content: Buffer.from(sheetXml, 'utf8') },
        ]);

        const entries = extractZipEntries(zipBuffer);
        assert.strictEqual(entries.size, 4);

        const rows = parseXlsxFirstSheet(zipBuffer);
        assert.deepStrictEqual(rows, [
            ['Name', 'ISIN', '', 'Weight (%)'],
            ['AT&T Inc <US>', 'US00206R1023', '', '4.25'],
        ]);
    });

    test('throws a clear error on non-ZIP or missing-worksheet payloads', () => {
        assert.throws(
            () => parseXlsxFirstSheet(Buffer.from('<html>Not Found</html>', 'utf8')),
            /missing PKZIP signature/i
        );

        const emptyZip = buildMinimalZip([
            { name: 'xl/workbook.xml', content: Buffer.from('<workbook/>', 'utf8') },
        ]);
        assert.throws(
            () => parseXlsxFirstSheet(emptyZip),
            /no worksheet XML entry found/i
        );
    });
});
