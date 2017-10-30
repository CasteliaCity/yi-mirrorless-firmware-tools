'use strict';

const fs = require('fs');
const path = require('path');
const S = require('string');

const FW_SECTION_HEADER_LENGTH = 0x100;

function parseHeader(headerString) {
    let parsedHeader = {
        sectionId: undefined,
        sectionLength: undefined,
        deviceId: undefined,
        deviceVersion: undefined,
        dvr: undefined,
        sectionSum: undefined,
        sectionOffset: undefined,
        followingSectionIds: undefined,
    };

    const parts = headerString.split(' ')
    // Remove empty items (null strings / spaces)
        .filter((part) => part !== '')
        // Remove whitespace paddings
        .map((part) => part.trim());

    // Parse the header parts into the parsedHeader structure
    parts.forEach((part, index) => {
        const isKeyValue = part.indexOf('=') !== -1;
        // The first part is a potential section Id
        if (!isKeyValue && index === 0) {
            parsedHeader.sectionId = part;
            return;
        }

        // After the potential section Id and the length follows the device Id
        if (!isKeyValue && index < 3) {
            parsedHeader.deviceId = part;
            return;
        }

        if (isKeyValue) {
            const [key, value] = part.split('=');

            switch (key) {
                case 'LENGTH':
                    parsedHeader.sectionLength = parseInt(value);
                    break;

                case 'VER':
                    parsedHeader.deviceVersion = value;
                    break;

                case 'DVR':
                    parsedHeader.dvr = value;
                    break;

                case 'SUM':
                    parsedHeader.sectionSum = parseInt(value);
                    break;

                case 'OFFSET':
                    parsedHeader.sectionOffset = parseInt(value);
                    break;
            }
        } else {
            parsedHeader.followingSectionIds = parsedHeader.followingSectionIds || [];
            parsedHeader.followingSectionIds.push(part);
        }
    });

    // Remove undefined properties
    parsedHeader = JSON.parse(JSON.stringify(parsedHeader));

    return parsedHeader;
}

function unpack(fileName, targetDirectory) {
    const fd = fs.openSync(fileName, 'r');
    const headerBuffer = Buffer.alloc(FW_SECTION_HEADER_LENGTH);

    let readPosition = 0;
    let sectionCount = 0;

    while (true) {
        // Read section header
        let bytesRead = fs.readSync(fd, headerBuffer, 0, headerBuffer.length, readPosition);
        readPosition += bytesRead;

        // Check for EOF if no more header was read
        if (bytesRead === 0) {
            console.log('EOF');
            return;
        }

        console.log(`----- Section ${sectionCount} -----`);

        // Parse section header
        const headerString = headerBuffer.toString('ascii').trim();
        console.log(`Raw header string: ${headerString}`);
        const header = parseHeader(headerString);
        console.log(`Parsed header:`, header);

        // Read section body
        const sectionBuffer = Buffer.alloc(header.sectionLength);
        bytesRead = fs.readSync(fd, sectionBuffer, 0, sectionBuffer.length, readPosition);
        readPosition += bytesRead;

        // Check read for completeness
        if (bytesRead < sectionBuffer.length) {
            throw `Incomplete section read: ${bytesRead} < ${sectionBuffer.length}`;
        } else {
            console.log(`Section read ok (${bytesRead} bytes)`);
        }

        // Calculate and test checksum
        let sum = 0;
        for (let i = 0; i < sectionBuffer.length; i++) {
            sum += sectionBuffer.readUInt8(i);
        }

        if (sum !== header.sectionSum) {
            throw `Checksum test failed: ${sum} != ${header.sectionSum}`;
        }
        else {
            console.log(`Checksum test ok (${sum})`);
        }

        // Write section to file
        const sectionFileName = path.basename(fileName)
            + `.${sectionCount}`
            + (header.sectionId ? `.${header.sectionId}` : '');

        fs.writeFileSync(path.join(targetDirectory, sectionFileName), sectionBuffer);
        console.log(`Output file: ${sectionFileName}`);

        sectionCount++;
    }
}

class RingBuffer {
    constructor(size) {
        this.buffer = Buffer.alloc(size);
        this.bufferIndex = 0;
    }

    get length() {
        return this.buffer.length;
    }

    get innerBuffer() {
        return this.buffer;
    }

    readUInt8(offset) {
        const readOffset = (this.bufferIndex + offset) % this.buffer.length;
        return this.buffer.readUInt8(readOffset);
    }

    appendUInt8(value) {
        this.buffer.writeUInt8(value, this.bufferIndex);
        this.bufferIndex = ++this.bufferIndex % this.buffer.length;
    }

    toString(encoding) {
        return this.buffer.toString(encoding, this.bufferIndex, this.buffer.length)
            + this.buffer.toString(encoding, 0, this.bufferIndex);
    }

    getSequentialBuffer() {
        return Buffer.concat([
            this.buffer.slice(this.bufferIndex, this.buffer.length),
            this.buffer.slice(0, this.bufferIndex),
        ]);
    }

    find(byteArray) {
        const check = (x) => {
            for (let y = 1; y < byteArray.length; y++) {
                if (this.buffer.readUInt8(x + y) !== byteArray[y]) {
                    return false;
                }
            }

            return true;
        };

        for (let x = 0; x < this.buffer.length; x++) {
            // Check the first value and if it matched, check all remaining ones
            if (this.buffer.readUInt8(x) === byteArray[0] && check(x)) {
                const offset = (this.buffer.length + x - this.bufferIndex) % this.buffer.length;
                // Return "external" offset (as used by readUInt8) and the actual internal offset
                return [offset, x];
            }
        }

        return [-1, -1];
    }
}

/**
 * Decompresses compressed data in section 0 of the firmware.
 * @param buffer
 * @returns {Buffer}
 */
function decompress(buffer) {
    const THRESHOLD = 3;
    const BUFFER_SIZE = 0x1000;
    const VERBOSE = false;

    let bufferByteIndex = 0;
    const lookupBuffer = new RingBuffer(BUFFER_SIZE);
    const outputBuffer = Buffer.alloc(buffer.length * 10); // the compression os probably way less effective so lets just hope this size is enough (else we have to implement dynamic resizing)
    let outputBufferByteIndex = 0;

    const readNextByte = () => {
        return buffer.readUInt8(bufferByteIndex++);
    };

    const writeNextByte = (value) => {
        if (outputBufferByteIndex === outputBuffer.length) {
            throw 'Output buffer is full, cannot write more data';
        }

        outputBuffer.writeUInt8(value, outputBufferByteIndex++);
    };

    const decodeFlagByte = (flagByte) => {
        const flags = [];

        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
            const copyByte = (flagByte >> bitIndex) & 1 === 1;
            flags.push(copyByte);
        }

        return flags;
    };

    const toBitString = (value, bits) => {
        return S(value.toString(2)).padLeft(bits, '0');
    };

    const toHexString = (value, bytes) => {
        return S(value.toString(16)).padLeft(bytes * 2, '0').toString().toUpperCase();
    };

    // Positions in the source file at which lookup bytes are stored, and their expected lookup result
    const analysisEntries = {
        3801324: 'ing',
        3801424: 'text/j',
        3801487: 'on\0',
        3801499: '\0video/',
        3807679: '2345',
        3807750: 'stuv',
        6769554: 'rst',
        6769842: 'uary',
        7364461: 'ata',
    };
    const analysisEntryKeys = Object.keys(analysisEntries).map((key) => Number(key));

    while (bufferByteIndex < buffer.length - 2) {
        // Read the flag byte, whose bits are flags that tell which bytes are to be copied directly, and which bytes
        // are lookup information.
        const flagByte = readNextByte();
        // Parse the flag byte into a boolean flag array
        const flags = decodeFlagByte(flagByte);

        if (VERBOSE) {
            const flagsByteBinaryString = toBitString(flagByte, 8);
            const flagsString = flags.map((flag) => flag ? 'C' : 'L').reduce((a, b) => a + b);
            console.log(`${bufferByteIndex - 1} flag: 0x${toHexString(flagByte, 1)}/${flagsByteBinaryString} => ${flagsString}`
                + (flagByte === 0xFF ? ' !!!!!' : ''));
        }

        for (let copyByte of flags) {
            if (copyByte) {
                // Just copy the byte into the output
                const byte = readNextByte();

                if (VERBOSE) {
                    console.log(`${bufferByteIndex - 1} copy: 0x${byte.toString(16)}`);
                }

                // Write byte into output and lookup buffer
                writeNextByte(byte);
                lookupBuffer.appendUInt8(byte);
            } else {
                // Read lookup data bytes (2 bytes)
                const lookup = readNextByte() << 8 | readNextByte();

                const lookupIndex = lookup >> 4;
                const lookupLength = (lookup & 0x000F) + THRESHOLD;

                if (VERBOSE) {
                    console.log(`${bufferByteIndex - 2} lookup: 0x${toHexString(lookup, 2)}/${toBitString(lookup, 16)} => ${lookupLength}@${lookupIndex}`);
                }

                // Read bytes from lookup buffer
                // TODO find out why the lookupIndex does not map correctly to the lookupBuffer (and has an inconsistent offset)
                const lookupBytes = [];
                for (let x = 0; x < lookupLength; x++) {
                    let bufferByte = lookupBuffer.readUInt8(lookupIndex + x);
                    lookupBytes.push(bufferByte);
                }

                // Analysis: check lookup expected vs. actual
                // This is just here for analytical purposes, to help find out what's wrong with the lookup buffer
                const byteIndex = bufferByteIndex - 2;
                const key = byteIndex + 0x2000;
                if (analysisEntryKeys.includes(key)) {
                    const expectedValue = analysisEntries[key]; // What we expect to read from the lookup buffer
                    const expectedValueArray = expectedValue.split('').map((char) => char.charCodeAt(0)); // the same as value array for the find operation
                    const read = lookupBytes.map((byte) => String.fromCharCode(byte)).reduce((a, b) => a + b); // What we actually read from the lookup buffer
                    const find = lookupBuffer.find(expectedValueArray); // Find the expected values in the buffer
                    console.log(`should be "${expectedValue}" but got "${read}"`);
                    console.log('expected index', lookupIndex);
                    console.log('actual index', find, expectedValueArray);
                    if (find[0] > -1) {
                        console.log(key + ' offset', find[0] - lookupIndex, find[1] - lookupIndex);
                    }
                }

                // Write bytes into output and lookup buffer
                lookupBytes.forEach((byte) => {
                    lookupBuffer.appendUInt8(byte);
                    writeNextByte(byte);
                });
            }
        }
    }

    return outputBuffer.slice(0, outputBufferByteIndex);
}

function decompressFile(fileName, targetDirectory) {
    const data = fs.readFileSync(fileName);

    // Skip the two uncompressed 0x1000 byte sections
    const compressedData = data.slice(0x2000);

    const decompressData = decompress(compressedData);

    const targetFileName = path.basename(fileName) + `.decompressed`;
    const targetFileNameFull = path.join(targetDirectory, targetFileName);
    fs.writeFileSync(targetFileNameFull, decompressData);

    const stats = {
        inputSize: compressedData.length,
        outputSize: decompressData.length,
        compressionRate: 1 / decompressData.length * compressedData.length,
        outputFile: targetFileNameFull,
    };

    console.log(`Decompression finished (${JSON.stringify(stats)})`);
}

exports.parseHeader = parseHeader;
exports.unpack = unpack;
exports.decompressFile = decompressFile;
