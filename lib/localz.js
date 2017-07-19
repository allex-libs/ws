var zlib = require('zlib');

var DEFAULT_WINDOW_BITS = 15;
var DEFAULT_MEM_LEVEL = 8;

function createDeflateRaw (maxWindowBits, memlevel) {
  return zlib.createDeflateRaw({
    flush: zlib.Z_SYNC_FLUSH,
    windowBits: 'number' === typeof maxWindowBits ? maxWindowBits : DEFAULT_WINDOW_BITS,
    memLevel: memlevel || DEFAULT_MEM_LEVEL
  })
}

function createInflateRaw (maxWindowBits) {
  return zlib.createInflateRaw({
    windowBits: 'number' === typeof maxWindowBits ? maxWindowBits : DEFAULT_WINDOW_BITS
  })
}

module.exports = {
  createDeflateRaw: createDeflateRaw,
  createInflateRaw: createInflateRaw
};
