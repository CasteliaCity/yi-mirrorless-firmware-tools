'use strict';

const path = require('path');
const firmware = require('./firmware');

if (process.argv.length <= 3) {
    console.log('usage: npm run [unpack|string] <inputfile>');
    console.log(' unpack: unpacks a firmware file into its sections (needs full firmware file as input)');
    console.log(' decompress: decompresses section 0 (needs section 0 as input)');
    console.error('Arguments missing');
    return;
}

const command = process.argv[2];
const inputFileName = process.argv[3];
const outputDirectoryName = path.dirname(inputFileName);

try {
    switch (command) {
        case 'unpack':
            firmware.unpack(inputFileName, outputDirectoryName);
            break;

        case 'decompress':
            firmware.decompressFile(inputFileName, outputDirectoryName);
            break;

        default:
            console.error(`Unknown command: ${command}`);
    }
} catch (error) {
    console.error(error);
}
