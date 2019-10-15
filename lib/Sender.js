/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

var events = require('events')
  , util = require('util')
  , EventEmitter = events.EventEmitter
  , ErrorCodes = require('./ErrorCodes')
  , bufferUtil = require('./BufferUtil')
  , PerMessageDeflate = require('./PerMessageDeflate');

/**
 * HyBi Sender implementation
 */

function Sender(socket, extensions) {
  if (this instanceof Sender === false) {
    throw new TypeError("Classes can't be function-called");
  }

  events.EventEmitter.call(this);

  this._socket = socket;
  this.extensions = extensions || {};
  this.firstFragment = true;
  this.compress = false;
  this.messageHandlers = [];
  this.processing = false;
  this.flusherBound = this.flusher.bind(this);
  this.onErrorBound = this.onError.bind(this);
  if ('function' === typeof this._socket.on) {
    this._socket.on('error', this.onErrorBound);
  }
}

/**
 * Inherits from EventEmitter.
 */

util.inherits(Sender, events.EventEmitter);

Sender.prototype.destroy = function () {
  if (this._socket && 'function' === typeof this._socket.removeListener) {
    this._socket.removeListener('error', this.onErrorBound);
  }
  this.onErrorBound = null;
  this.flusherBound = null;
  this.processing = null;
  this.messageHandlers = null;
  this.compress = null;
  this.firstFragment = null;
  this.extensions = null;
  this._socket = null;
};

function closer (mask, databuffer, cb, callback) {
  this.frameAndSend(0x8, databuffer, true, mask);
  callback();
  if (typeof cb == 'function') cb();
}

/**
 * Sends a close instruction to the remote party.
 *
 * @api public
 */

Sender.prototype.close = function(code, data, mask, cb) {
  if (typeof code !== 'undefined') {
    if (typeof code !== 'number' ||
      !ErrorCodes.isValidErrorCode(code)) throw new Error('first argument must be a valid error code number');
  }
  code = code || 1000;
  var dataBuffer = new Buffer(2 + (data ? Buffer.byteLength(data) : 0));
  writeUInt16BE.call(dataBuffer, code, 0);
  if (dataBuffer.length > 2) dataBuffer.write(data, 2);

  this.messageHandlers.push(closer.bind(this, mask, dataBuffer, cb));
  this.flush();
};

function pinger (mask, data, callback) {
  this.frameAndSend(0x9, data || '', true, mask);
  callback();
}

/**
 * Sends a ping message to the remote party.
 *
 * @api public
 */

Sender.prototype.ping = function(data, options) {
  this.messageHandlers.push(pinger.bind(this, options && options.mask, data));
  this.flush();
};

function ponger (mask, data, callback) {
  this.frameAndSend(0xa, data || '', true, mask);
  callback();
}

/**
 * Sends a pong message to the remote party.
 *
 * @api public
 */

Sender.prototype.pong = function(data, options) {
  this.messageHandlers.push(ponger.bind(this, options && options.mask, data));
  this.flush();
};

function onExtensionsAppliedForSend (opcode, finalFragment, mask, compress, cb, callback, err, data) {
  if (err) {
    if (typeof cb == 'function') cb(err);
    else this.emit('error', err);
    return;
  }
  this.frameAndSend(opcode, data, finalFragment, mask, compress, cb);
  callback();
}

function sender (data, finalFragment, compressFragment, opcode, mask, compress, cb, callback) {
  try {
  this.applyExtensions(data, finalFragment, compressFragment, onExtensionsAppliedForSend.bind(this, opcode, finalFragment, mask, compress, cb, callback ));
  } catch(e) {
    console.error(e.stack);
    console.error(e);
    process.exit(0);
  }
}

Sender.prototype.onError = function (err) {
  //console.error('WebSocket error in', this.constructor.name, err);
  this.emit('error', err);
};

/**
 * Sends text or binary data to the remote party.
 *
 * @api public
 */

Sender.prototype.send = function(data, options, cb) {
  var finalFragment = options && options.fin === false ? false : true;
  var mask = options && options.mask;
  var compress = options && options.compress;
  var opcode = options && options.binary ? 2 : 1;
  if (this.firstFragment === false) {
    opcode = 0;
    compress = false;
  } else {
    this.firstFragment = false;
    this.compress = compress;
  }
  if (finalFragment) this.firstFragment = true;

  var compressFragment = this.compress;

  this.messageHandlers.push(sender.bind(this, data, finalFragment, compressFragment, opcode, mask, compress, cb));
  this.flush();
};

/**
 * Frames and sends a piece of data according to the HyBi WebSocket protocol.
 *
 * @api private
 */

Sender.prototype.frameAndSend = function(opcode, data, finalFragment, maskData, compressed, cb) {
  var canModifyData = false;

  if (!this._socket) {
    return;
  }

  if (!data) {
    try {
      this._socket.write(new Buffer([opcode | (finalFragment ? 0x80 : 0), 0 | (maskData ? 0x80 : 0)].concat(maskData ? [0, 0, 0, 0] : [])), 'binary', cb);
    }
    catch (e) {
      if (typeof cb == 'function') cb(e);
      else this.emit('error', e);
    }
    return;
  }

  if (!Buffer.isBuffer(data)) {
    canModifyData = true;
    if (data && (typeof data.byteLength !== 'undefined' || typeof data.buffer !== 'undefined')) {
      data = getArrayBuffer(data);
    } else {
      //
      // If people want to send a number, this would allocate the number in
      // bytes as memory size instead of storing the number as buffer value. So
      // we need to transform it to string in order to prevent possible
      // vulnerabilities / memory attacks.
      //
      if (typeof data === 'number') data = data.toString();

      data = new Buffer(data);
    }
  }

  var dataLength = data.length
    , dataOffset = maskData ? 6 : 2
    , secondByte = dataLength;

  if (dataLength >= 65536) {
    dataOffset += 8;
    secondByte = 127;
  }
  else if (dataLength > 125) {
    dataOffset += 2;
    secondByte = 126;
  }

  var mergeBuffers = dataLength < 32768 || (maskData && !canModifyData);
  var totalLength = mergeBuffers ? dataLength + dataOffset : dataOffset;
  var outputBuffer = new Buffer(totalLength);
  outputBuffer[0] = finalFragment ? opcode | 0x80 : opcode;
  if (compressed) outputBuffer[0] |= 0x40;

  switch (secondByte) {
    case 126:
      writeUInt16BE.call(outputBuffer, dataLength, 2);
      break;
    case 127:
      writeUInt32BE.call(outputBuffer, 0, 2);
      writeUInt32BE.call(outputBuffer, dataLength, 6);
  }

  if (maskData) {
    outputBuffer[1] = secondByte | 0x80;
    var mask = getRandomMask();
    outputBuffer[dataOffset - 4] = mask[0];
    outputBuffer[dataOffset - 3] = mask[1];
    outputBuffer[dataOffset - 2] = mask[2];
    outputBuffer[dataOffset - 1] = mask[3];
    if (mergeBuffers) {
      bufferUtil.mask(data, mask, outputBuffer, dataOffset, dataLength);
      try {
        this._socket.write(outputBuffer, 'binary', cb);
      }
      catch (e) {
        if (typeof cb == 'function') cb(e);
        else this.emit('error', e);
      }
    }
    else {
      bufferUtil.mask(data, mask, data, 0, dataLength);
      try {
        this._socket.write(outputBuffer, 'binary');
        this._socket.write(data, 'binary', cb);
      }
      catch (e) {
        if (typeof cb == 'function') cb(e);
        else this.emit('error', e);
      }
    }
  }
  else {
    outputBuffer[1] = secondByte;
    if (mergeBuffers) {
      data.copy(outputBuffer, dataOffset);
      try {
        this._socket.write(outputBuffer, 'binary', cb);
      }
      catch (e) {
        if (typeof cb == 'function') cb(e);
        else this.emit('error', e);
      }
    }
    else {
      try {
        this._socket.write(outputBuffer, 'binary');
        this._socket.write(data, 'binary', cb);
      }
      catch (e) {
        if (typeof cb == 'function') cb(e);
        else this.emit('error', e);
      }
    }
  }
};


/**
 * Execute message handler buffers
 *
 * @api private
 */

Sender.prototype.flush = function() {
  if (this.processing) return;

  var handler = this.messageHandlers.shift();
  if (!handler) return;

  this.processing = true;

  handler(this.flusherBound);
};

Sender.prototype.flusher = function () {
  this.processing = false;
  this.flush();
};

/**
 * Apply extensions to message
 *
 * @api private
 */

Sender.prototype.applyExtensions = function(data, fin, compress, callback) {
  if (compress && data) {
    if ((data.buffer || data) instanceof ArrayBuffer) {
      data = getArrayBuffer(data);
    }
    this.extensions[PerMessageDeflate.extensionName].compress(data, fin, callback);
  } else {
    callback(null, data);
  }
};

module.exports = Sender;

function writeUInt16BE(value, offset) {
  this[offset] = (value & 0xff00)>>8;
  this[offset+1] = value & 0xff;
}

function writeUInt32BE(value, offset) {
  this[offset] = (value & 0xff000000)>>24;
  this[offset+1] = (value & 0xff0000)>>16;
  this[offset+2] = (value & 0xff00)>>8;
  this[offset+3] = value & 0xff;
}

function getArrayBuffer(data) {
  // data is either an ArrayBuffer or ArrayBufferView.
  var array = new Uint8Array(data.buffer || data)
    , l = data.byteLength || data.length
    , o = data.byteOffset || 0
    , buffer = new Buffer(l);
  for (var i = 0; i < l; ++i) {
    buffer[i] = array[o+i];
  }
  return buffer;
}

function getRandomMask() {
  return new Buffer([
    ~~(Math.random() * 255),
    ~~(Math.random() * 255),
    ~~(Math.random() * 255),
    ~~(Math.random() * 255)
  ]);
}
