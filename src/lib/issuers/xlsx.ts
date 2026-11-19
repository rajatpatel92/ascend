import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CEN_SIGNATURE = 0x02014b50;
const LOC_SIGNATURE = 0x04034b50;

interface ZipEntryRecord {
    name: string;
    compressionMethod: number;
    compressedSize: number;
    localHeaderOffset: number;
}

function decodeXmlEntities(raw: string): string {
    if (!raw.includes('&')) return raw;
    return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (full, entity: string) => {
        switch (entity) {
            case 'amp':
                return '&';
            case 'lt':
                return '<';
            case 'gt':
                return '>';
            case 'quot':
                return '"';
            case 'apos':
                return "'";
            default: {
                const codePoint = entity.startsWith('#x')
                    ? Number.parseInt(entity.slice(2), 16)
                    : Number.parseInt(entity.slice(1), 10);
                if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
                    return String.fromCodePoint(codePoint);
                }
                return full;
            }
        }
    });
}

function cleanCell(value: string): string {
    return value.replace(/^\uFEFF/, '').replace(/\u00A0/g, ' ').trim();
}

function colRefToIndex(ref: string): number {
    const lettersMatch = ref.match(/^[A-Za-z]+/);
    if (!lettersMatch) return -1;
    const letters = lettersMatch[0].toUpperCase();
    let col = 0;
    for (let i = 0; i < letters.length; i++) {
        col = col * 26 + (letters.charCodeAt(i) - 64);
    }
    return col - 1;
}

function findEocdOffset(buf: Buffer): number {
    const minOffset = Math.max(0, buf.length - 65_557);
    for (let offset = buf.length - 22; offset >= minOffset; offset--) {
        if (buf.readUInt32LE(offset) === EOCD_SIGNATURE) {
            const commentLength = buf.readUInt16LE(offset + 20);
            if (offset + 22 + commentLength === buf.length) {
                return offset;
            }
        }
    }
    return -1;
}

/**
 * Extracts entries from a PKZIP buffer using Central Directory offsets (supports both stored and
 * deflated entries as well as streaming data-descriptor local headers emitted by Excel/OpenXML).
 */
export function extractZipEntries(input: Buffer | Uint8Array): Map<string, Buffer> {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        throw new Error('Invalid XLSX archive: missing PKZIP signature');
    }

    const eocdOffset = findEocdOffset(buf);
    if (eocdOffset < 0) {
        throw new Error('Invalid XLSX archive: End of Central Directory record not found');
    }

    const totalEntries = buf.readUInt16LE(eocdOffset + 10);
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    if (cdOffset + totalEntries * 46 > buf.length) {
        throw new Error('Invalid XLSX archive: corrupt Central Directory bounds');
    }

    const records: ZipEntryRecord[] = [];
    let cursor = cdOffset;
    for (let i = 0; i < totalEntries && cursor + 46 <= buf.length; i++) {
        if (buf.readUInt32LE(cursor) !== CEN_SIGNATURE) {
            throw new Error(`Invalid XLSX archive: unexpected Central Directory signature at ${cursor}`);
        }
        const compressionMethod = buf.readUInt16LE(cursor + 10);
        const compressedSize = buf.readUInt32LE(cursor + 20);
        const fileNameLength = buf.readUInt16LE(cursor + 28);
        const extraLength = buf.readUInt16LE(cursor + 30);
        const commentLength = buf.readUInt16LE(cursor + 32);
        const localHeaderOffset = buf.readUInt32LE(cursor + 42);

        const nameStart = cursor + 46;
        const nameEnd = nameStart + fileNameLength;
        const name = buf.toString('utf8', nameStart, nameEnd).replace(/^\/+/, '');
        records.push({
            name,
            compressionMethod,
            compressedSize,
            localHeaderOffset,
        });

        cursor = nameEnd + extraLength + commentLength;
    }

    const entries = new Map<string, Buffer>();
    for (const rec of records) {
        if (rec.localHeaderOffset + 30 > buf.length) continue;
        if (buf.readUInt32LE(rec.localHeaderOffset) !== LOC_SIGNATURE) {
            throw new Error(`Invalid XLSX archive: missing local header for ${rec.name}`);
        }
        const localNameLen = buf.readUInt16LE(rec.localHeaderOffset + 26);
        const localExtraLen = buf.readUInt16LE(rec.localHeaderOffset + 28);
        const dataStart = rec.localHeaderOffset + 30 + localNameLen + localExtraLen;
        const dataEnd = dataStart + rec.compressedSize;
        if (dataEnd > buf.length) {
            throw new Error(`Invalid XLSX archive: entry ${rec.name} exceeds buffer size`);
        }

        const compressedSlice = buf.subarray(dataStart, dataEnd);
        if (rec.compressionMethod === 0) {
            entries.set(rec.name, Buffer.from(compressedSlice));
        } else if (rec.compressionMethod === 8) {
            entries.set(rec.name, inflateRawSync(compressedSlice));
        } else {
            throw new Error(`Unsupported XLSX compression method ${rec.compressionMethod} for ${rec.name}`);
        }
    }

    return entries;
}

function getXmlAttribute(attrs: string, attrName: string): string | undefined {
    const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = attrs.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
    if (!match) return undefined;
    return decodeXmlEntities(match[1] ?? match[2] ?? '');
}

function extractConcatenatedTextRuns(fragment: string): string {
    const withoutPhonetic = fragment.replace(/<(?:[a-zA-Z0-9_]+:)?rPh\b[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_]+:)?rPh>/g, '');
    const tPattern = /<(?:[a-zA-Z0-9_]+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?t>/g;
    let combined = '';
    let match: RegExpExecArray | null;
    while ((match = tPattern.exec(withoutPhonetic)) !== null) {
        combined += decodeXmlEntities(match[1]);
    }
    return combined;
}

function parseSharedStrings(xml: string | undefined): string[] {
    if (!xml) return [];
    const strings: string[] = [];
    const siPattern = /<(?:[a-zA-Z0-9_]+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?si>/g;
    let match: RegExpExecArray | null;
    while ((match = siPattern.exec(xml)) !== null) {
        strings.push(extractConcatenatedTextRuns(match[1]));
    }
    return strings;
}

function resolveFirstWorksheetPath(entries: Map<string, Buffer>): string | undefined {
    const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8');
    const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');

    if (workbookXml && relsXml) {
        const sheetMatch = workbookXml.match(/<(?:[a-zA-Z0-9_]+:)?sheet\b([^>]*?)\/?>/);
        const firstRid = sheetMatch ? getXmlAttribute(sheetMatch[1], 'r:id') ?? getXmlAttribute(sheetMatch[1], 'id') : undefined;
        if (firstRid) {
            const relPattern = /<(?:[a-zA-Z0-9_]+:)?Relationship\b([^>]*?)\/?>/g;
            let relMatch: RegExpExecArray | null;
            while ((relMatch = relPattern.exec(relsXml)) !== null) {
                const attrs = relMatch[1];
                if (getXmlAttribute(attrs, 'Id') === firstRid) {
                    const target = getXmlAttribute(attrs, 'Target');
                    if (target) {
                        const normalized = target.startsWith('/')
                            ? target.slice(1)
                            : target.startsWith('../')
                              ? target.replace(/^(\.\.\/)+/, '')
                              : target.startsWith('xl/')
                                ? target
                                : `xl/${target}`;
                        if (entries.has(normalized)) {
                            return normalized;
                        }
                    }
                }
            }
        }
    }

    if (entries.has('xl/worksheets/sheet1.xml')) {
        return 'xl/worksheets/sheet1.xml';
    }

    for (const key of entries.keys()) {
        if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(key)) {
            return key;
        }
    }

    return undefined;
}

function parseWorksheetRows(sheetXml: string, sharedStrings: string[]): string[][] {
    const rows: string[][] = [];
    const rowPattern = /<(?:[a-zA-Z0-9_]+:)?row\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?row>/g;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowPattern.exec(sheetXml)) !== null) {
        const rowBody = rowMatch[1];
        const rowCells: string[] = [];
        let fallbackCol = 0;

        let searchPos = 0;
        while (searchPos < rowBody.length) {
            const openIdx = rowBody.indexOf('<', searchPos);
            if (openIdx === -1) break;

            const tagEnd = rowBody.indexOf('>', openIdx + 1);
            if (tagEnd === -1) break;

            const tagInner = rowBody.slice(openIdx + 1, tagEnd);
            const cHeaderMatch = tagInner.match(/^(?:[a-zA-Z0-9_]+:)?c(?:\s([\s\S]*))?$/);
            if (!cHeaderMatch) {
                searchPos = tagEnd + 1;
                continue;
            }

            const rawAttrs = cHeaderMatch[1] ?? '';
            const selfClosing = rawAttrs.endsWith('/');
            const attrs = selfClosing ? rawAttrs.slice(0, -1) : rawAttrs;

            let cellBody = '';
            if (selfClosing) {
                searchPos = tagEnd + 1;
            } else {
                const closeMatch = rowBody.slice(tagEnd + 1).match(/<\/(?:[a-zA-Z0-9_]+:)?c>/);
                if (!closeMatch || closeMatch.index === undefined) {
                    searchPos = tagEnd + 1;
                    continue;
                }
                cellBody = rowBody.slice(tagEnd + 1, tagEnd + 1 + closeMatch.index);
                searchPos = tagEnd + 1 + closeMatch.index + closeMatch[0].length;
            }

            const refAttr = getXmlAttribute(attrs, 'r');
            const parsedCol = refAttr ? colRefToIndex(refAttr) : -1;
            const colIdx = parsedCol >= 0 ? parsedCol : fallbackCol;
            fallbackCol = colIdx + 1;

            let cellValue = '';
            const cellType = getXmlAttribute(attrs, 't')?.toLowerCase();
            if (cellType === 'inlineStr'.toLowerCase()) {
                const isMatch = cellBody.match(/<(?:[a-zA-Z0-9_]+:)?is\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?is>/);
                cellValue = extractConcatenatedTextRuns(isMatch ? isMatch[1] : cellBody);
            } else {
                const vMatch = cellBody.match(/<(?:[a-zA-Z0-9_]+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-zA-Z0-9_]+:)?v>/);
                if (vMatch) {
                    const rawVal = decodeXmlEntities(vMatch[1]);
                    if (cellType === 's') {
                        const ssIdx = Number.parseInt(rawVal.trim(), 10);
                        cellValue = Number.isFinite(ssIdx) ? (sharedStrings[ssIdx] ?? '') : '';
                    } else {
                        cellValue = rawVal;
                    }
                }
            }

            while (rowCells.length <= colIdx) {
                rowCells.push('');
            }
            rowCells[colIdx] = cleanCell(cellValue);
        }

        if (rowCells.length > 0) {
            rows.push(rowCells);
        }
    }

    return rows;
}

/**
 * Parses the first worksheet of an `.xlsx` workbook buffer into trimmed string rows.
 */
export function parseXlsxFirstSheet(buffer: Buffer | Uint8Array): string[][] {
    const entries = extractZipEntries(buffer);
    const sheetPath = resolveFirstWorksheetPath(entries);
    if (!sheetPath) {
        throw new Error('Invalid XLSX archive: no worksheet XML entry found');
    }
    const sheetXml = entries.get(sheetPath)?.toString('utf8');
    if (!sheetXml) {
        throw new Error(`Invalid XLSX archive: empty worksheet entry ${sheetPath}`);
    }
    const sharedStringsXml = entries.get('xl/sharedStrings.xml')?.toString('utf8');
    const sharedStrings = parseSharedStrings(sharedStringsXml);
    return parseWorksheetRows(sheetXml, sharedStrings);
}
