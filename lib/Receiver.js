/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

var util = require('util')
  , isValidUTF8 = require('./Validation')
  , ErrorCodes = require('./ErrorCodes')
  , BufferPool = require('./BufferPool')
  , bufferUtil = require('./BufferUtil')
  , PerMessageDeflate = require('./PerMessageDeflate');

/**
 * HyBi Receiver implementation
 */

function growStrategy (db, length) {
  return db.used + length;
}
function fragmentedShrinkStrategy (db, length) {
}
function Shrinker () {
  this.prevsize = -1;
}
Shrinker.prototype.destroy = function () {
  this.prevsize = null;
};
Shrinker.prototype.newSize = function (db) {
  if (this.prevsize === null) {
    return 0;
  }
  var ret = this.prevsize >= 0 ?
      Math.ceil((this.prevsize + db.used) / 2) :
      db.used;
  this.prevsize = ret;
  return ret;
};
Shrinker.prototype.strategy = function () {
  return this.newSize.bind(this);
};

function Receiver (extensions,maxPayload) {
  if (this instanceof Receiver === false) {
    throw new TypeError("Classes can't be function-called");
  }
  if(typeof extensions==='number'){
    maxPayload=extensions;
    extensions={};
  }


  // memory pool for fragmented messages
  this.fragmentedShrinker = new Shrinker();
  this.fragmentedBufferPool = new BufferPool(1024, growStrategy, this.fragmentedShrinker.strategy());

  // memory pool for unfragmented messages
  this.unfragmentedShrinker = new Shrinker();
  this.unfragmentedBufferPool = new BufferPool(1024, growStrategy, this.unfragmentedShrinker.strategy());
  this.extensions = extensions || {};
  this.maxPayload = maxPayload || 0;
  this.currentPayloadLength = 0;
  this.state = {
    activeFragmentedOperation: null,
    lastFragment: false,
    masked: false,
    opcode: 0,
    fragmentedOperation: false
  };
  this.overflow = [];
  this.headerBuffer = new Buffer(10);
  this.expectOffset = 0;
  this.expectBuffer = null;
  this.expectHandler = null;
  this.currentMessage = [];
  this.currentMessageLength = 0;
  this.messageHandlers = [];
  this.expectHeader(2, this.processPacket);
  this.dead = false;
  this.processing = false;

  this.onerror = function() {};
  this.ontext = function() {};
  this.onbinary = function() {};
  this.onclose = function() {};
  this.onping = function() {};
  this.onpong = function() {};
}

module.exports = Receiver;

/**
 * Add new data to the parser.
 *
 * @api public
 */

Receiver.prototype.add = function(data) {
  if (this.dead) return;
  var dataLength = data.length;
  if (dataLength == 0) return;
  if (this.expectBuffer == null) {
    this.overflow.push(data);
    return;
  }
  var toRead = Math.min(dataLength, this.expectBuffer.length - this.expectOffset);
  fastCopy(toRead, data, this.expectBuffer, this.expectOffset);
  this.expectOffset += toRead;
  if (toRead < dataLength) {
    this.overflow.push(data.slice(toRead));
  }
  while (this.expectBuffer && this.expectOffset == this.expectBuffer.length) {
    var bufferForHandler = this.expectBuffer;
    this.expectBuffer = null;
    this.expectOffset = 0;
    this.expectHandler.call(this, bufferForHandler);
  }
};

/**
 * Releases all resources used by the receiver.
 *
 * @api public
 */

Receiver.prototype.cleanup = function() {
  this.dead = true;
  this.overflow = null;
  this.headerBuffer = null;
  this.expectBuffer = null;
  this.expectHandler = null;
  if (this.unfragmentedShrinker) {
    this.unfragmentedShrinker.destroy();
  }
  this.unfragmentedShrinker = null;
  if (this.unfragmentedBufferPool) {
    this.unfragmentedBufferPool.destroy();
  }
  this.unfragmentedBufferPool = null;
  if (this.fragmentedShrinker) {
    this.fragmentedShrinker.destroy();
  }
  this.fragmentedShrinker = null;
  if (this.fragmentedBufferPool) {
    this.fragmentedBufferPool.destroy();
  }
  this.fragmentedBufferPool = null;
  this.state = null;
  this.currentMessage = null;
  this.onerror = null;
  this.ontext = null;
  this.onbinary = null;
  this.onclose = null;
  this.onping = null;
  this.onpong = null;
};

/**
 * Waits for a certain amount of header bytes to be available, then fires a callback.
 *
 * @api private
 */

Receiver.prototype.expectHeader = function(length, handler) {
  if (length == 0) {
    handler(null);
    return;
  }
  this.expectBuffer = this.headerBuffer.slice(this.expectOffset, this.expectOffset + length);
  this.expectHandler = handler;
  var toRead = length;
  while (toRead > 0 && this.overflow.length > 0) {
    var fromOverflow = this.overflow.pop();
    if (toRead < fromOverflow.length) this.overflow.push(fromOverflow.slice(toRead));
    var read = Math.min(fromOverflow.length, toRead);
    fastCopy(read, fromOverflow, this.expectBuffer, this.expectOffset);
    this.expectOffset += read;
    toRead -= read;
  }
};

/**
 * Waits for a certain amount of data bytes to be available, then fires a callback.
 *
 * @api private
 */

Receiver.prototype.expectData = function(length, handler) {
  if (length == 0) {
    handler(null);
    return;
  }
  this.expectBuffer = this.allocateFromPool(length, this.state.fragmentedOperation);
  this.expectHandler = handler;
  var toRead = length;
  while (toRead > 0 && this.overflow.length > 0) {
    var fromOverflow = this.overflow.pop();
    if (toRead < fromOverflow.length) this.overflow.push(fromOverflow.slice(toRead));
    var read = Math.min(fromOverflow.length, toRead);
    fastCopy(read, fromOverflow, this.expectBuffer, this.expectOffset);
    this.expectOffset += read;
    toRead -= read;
  }
};

/**
 * Allocates memory from the buffer pool.
 *
 * @api private
 */

Receiver.prototype.allocateFromPool = function(length, isFragmented) {
  return (isFragmented ? this.fragmentedBufferPool : this.unfragmentedBufferPool).get(length);
};

/**
 * Start processing a new packet.
 *
 * @api private
 */

Receiver.prototype.processPacket = function (data) {
  if (this.extensions[PerMessageDeflate.extensionName]) {
    if ((data[0] & 0x30) != 0) {
      this.error('reserved fields (2, 3) must be empty', 1002);
      return;
    }
  } else {
    if ((data[0] & 0x70) != 0) {
      this.error('reserved fields must be empty', 1002);
      return;
    }
  }
  this.state.lastFragment = (data[0] & 0x80) == 0x80;
  this.state.masked = (data[1] & 0x80) == 0x80;
  var compressed = (data[0] & 0x40) == 0x40;
  var opcode = data[0] & 0xf;
  if (opcode === 0) {
    if (compressed) {
      this.error('continuation frame cannot have the Per-message Compressed bits', 1002);
      return;
    }
    // continuation frame
    this.state.fragmentedOperation = true;
    this.state.opcode = this.state.activeFragmentedOperation;
    if (!(this.state.opcode == 1 || this.state.opcode == 2)) {
      this.error('continuation frame cannot follow current opcode', 1002);
      return;
    }
  }
  else {
    if (opcode < 3 && this.state.activeFragmentedOperation != null) {
      this.error('data frames after the initial data frame must have opcode 0', 1002);
      return;
    }
    if (opcode >= 8 && compressed) {
      this.error('control frames cannot have the Per-message Compressed bits', 1002);
      return;
    }
    this.state.compressed = compressed;
    this.state.opcode = opcode;
    if (this.state.lastFragment === false) {
      this.state.fragmentedOperation = true;
      this.state.activeFragmentedOperation = opcode;
    }
    else this.state.fragmentedOperation = false;
  }
  var handler = this['start_'+this.state.opcode];
  if (typeof handler == 'undefined') this.error('no handler for opcode ' + this.state.opcode, 1002);
  else {
    handler.call(this, data);
  }
};

/**
 * Endprocessing a packet.
 *
 * @api private
 */

Receiver.prototype.endPacket = function() {
  if (this.dead) return;
  if (!this.state.fragmentedOperation) this.unfragmentedBufferPool.reset(true);
  else if (this.state.lastFragment) this.fragmentedBufferPool.reset(true);
  this.expectOffset = 0;
  this.expectBuffer = null;
  this.expectHandler = null;
  if (this.state.lastFragment && this.state.opcode === this.state.activeFragmentedOperation) {
    // end current fragmented operation
    this.state.activeFragmentedOperation = null;
  }
  this.currentPayloadLength = 0;
  this.state.lastFragment = false;
  this.state.opcode = this.state.activeFragmentedOperation != null ? this.state.activeFragmentedOperation : 0;
  this.state.masked = false;
  this.expectHeader(2, this.processPacket);
};

/**
 * Reset the parser state.
 *
 * @api private
 */

Receiver.prototype.reset = function() {
  if (this.dead) return;
  this.state = {
    activeFragmentedOperation: null,
    lastFragment: false,
    masked: false,
    opcode: 0,
    fragmentedOperation: false
  };
  this.fragmentedBufferPool.reset(true);
  this.unfragmentedBufferPool.reset(true);
  this.expectOffset = 0;
  this.expectBuffer = null;
  this.expectHandler = null;
  this.overflow = [];
  this.currentMessage = [];
  this.currentMessageLength = 0;
  this.messageHandlers = [];
  this.currentPayloadLength = 0;
};

/**
 * Unmask received data.
 *
 * @api private
 */

Receiver.prototype.unmask = function (mask, buf, binary) {
  if (mask != null && buf != null) bufferUtil.unmask(buf, mask);
  if (binary) return buf;
  return buf != null ? buf.toString('utf8') : '';
};

/**
 * Handles an error
 *
 * @api private
 */

Receiver.prototype.error = function (reason, protocolErrorCode) {
  if (this.dead) return;
  this.reset();
  if(typeof reason == 'string'){
    this.onerror(new Error(reason), protocolErrorCode);
  }
  else if(reason.constructor == Error){
    this.onerror(reason, protocolErrorCode);
  }
  else{
    this.onerror(new Error("An error occured"),protocolErrorCode);
  }
  return this;
};

/**
 * Execute message handler buffers
 *
 * @api private
 */

Receiver.prototype.flush = function() {
  if (this.processing || this.dead) return;

  var handler = this.messageHandlers.shift();
  if (!handler) return;

  this.processing = true;

  handler(flusher.bind(this));
};

function flusher () {
  this.processing = false;
  this.flush();
}

/**
 * Apply extensions to message
 *
 * @api private
 */

Receiver.prototype.applyExtensions = function(messageBuffer, fin, compressed, callback) {
  if (compressed) {
    this.extensions[PerMessageDeflate.extensionName].decompress(messageBuffer, fin, onExtensionApplied.bind(this, callback));
  } else {
    callback(null, messageBuffer);
  }
};

function onExtensionApplied (callback, err, buffer) {
  if (this.dead) {
    callback = null;
    err = null;
    buffer = null;
    return;
  }
  if (err) {
    callback(new Error('invalid compressed data'));
    callback = null;
    err = null;
    buffer = null;
    return;
  }
  callback(null, buffer);
  callback = null;
  err = null;
  buffer = null;
}

/**
* Checks payload size, disconnects socket when it exceeds maxPayload
*
* @api private
*/
Receiver.prototype.maxPayloadExceeded = function(length) {
  if (this.maxPayload=== undefined || this.maxPayload === null || this.maxPayload < 1) {
    return false;
  }
  var fullLength = this.currentPayloadLength + length;
  if (fullLength < this.maxPayload) {
    this.currentPayloadLength = fullLength;
    return false;
  }
  this.error('payload cannot exceed ' + this.maxPayload + ' bytes', 1009);
  this.messageBuffer=[];
  this.cleanup();

  return true;
};

/**
 * Buffer utilities
 */

function readUInt16BE(start) {
  return (this[start]<<8) +
         this[start+1];
}

function readUInt32BE(start) {
  return (this[start]<<24) +
         (this[start+1]<<16) +
         (this[start+2]<<8) +
         this[start+3];
}

function fastCopy(length, srcBuffer, dstBuffer, dstOffset) {
  switch (length) {
    default: srcBuffer.copy(dstBuffer, dstOffset, 0, length); break;
    case 16: dstBuffer[dstOffset+15] = srcBuffer[15];
    case 15: dstBuffer[dstOffset+14] = srcBuffer[14];
    case 14: dstBuffer[dstOffset+13] = srcBuffer[13];
    case 13: dstBuffer[dstOffset+12] = srcBuffer[12];
    case 12: dstBuffer[dstOffset+11] = srcBuffer[11];
    case 11: dstBuffer[dstOffset+10] = srcBuffer[10];
    case 10: dstBuffer[dstOffset+9] = srcBuffer[9];
    case 9: dstBuffer[dstOffset+8] = srcBuffer[8];
    case 8: dstBuffer[dstOffset+7] = srcBuffer[7];
    case 7: dstBuffer[dstOffset+6] = srcBuffer[6];
    case 6: dstBuffer[dstOffset+5] = srcBuffer[5];
    case 5: dstBuffer[dstOffset+4] = srcBuffer[4];
    case 4: dstBuffer[dstOffset+3] = srcBuffer[3];
    case 3: dstBuffer[dstOffset+2] = srcBuffer[2];
    case 2: dstBuffer[dstOffset+1] = srcBuffer[1];
    case 1: dstBuffer[dstOffset] = srcBuffer[0];
  }
}

function clone(obj) {
  var cloned = {};
  for (var k in obj) {
    if (obj.hasOwnProperty(k)) {
      cloned[k] = obj[k];
    }
  }
  return cloned;
}

/**
 * Text handling methods
 */
function onHeader2_text(data) {
  var length = readUInt16BE.call(data, 0);
  if (this.maxPayloadExceeded(length)){
    this.error('Maximumpayload exceeded in compressed text message. Aborting...', 1009);
    return;
  }
  getData_text.call(this, length);
}
function onHeader4_text(length, data) {
  this.expectData(length, onDataFromHeader4_text.bind(this, data));
}
function onHeader8_text(data) {
  if (readUInt32BE.call(data, 0) != 0) {
    this.error('packets with length spanning more than 32 bit is currently not supported', 1008);
    return;
  }
  var length = readUInt32BE.call(data, 4);
  if (this.maxPayloadExceeded(length)){
    this.error('Maximumpayload exceeded in compressed text message. Aborting...', 1009);
    return;
  }
  getData_text.call(this, readUInt32BE.call(data, 4));
}
function onDataFromHeader4_text(mask, data) {
  finish_text.call(this, mask, data);
}
function getData_text(length) {
  if (this.state.masked) {
    this.expectHeader(4, onHeader4_text.bind(this, length));
  }
  else {
    this.expectData(length, onData_text.bind(this));
  }
}
function onData_text (data) {
  finish_text.call(this, null, data);
}
function onExtensions_text (state, callback, err, buffer) {
      if (err) {
        if(err.type===1009){
            return this.error('Maximumpayload exceeded in compressed text message. Aborting...', 1009);
        }
        return this.error(err.message, 1007);
      }
      if (buffer != null) {
        if( this.maxPayload==0 || (this.maxPayload > 0 && (this.currentMessageLength + buffer.length) < this.maxPayload) ){
          this.currentMessage.push(buffer);
        }
        else{
            this.currentMessage=null;
            this.currentMessage = [];
            this.currentMessageLength = 0;
            this.error(new Error('Maximum payload exceeded. maxPayload: '+this.maxPayload), 1009);
            return;
        }
        this.currentMessageLength += buffer.length;
      }
      if (state.lastFragment) {
        var messageBuffer = Buffer.concat(this.currentMessage);
        this.currentMessage = [];
        this.currentMessageLength = 0;
        if (!isValidUTF8(messageBuffer)) {
          this.error('invalid utf8 sequence', 1007);
          return;
        }
        this.ontext(messageBuffer.toString('utf8'), {masked: state.masked, buffer: messageBuffer});
      }
      callback();
    }
function messageHandler_text(packet, state, callback) {
  this.applyExtensions(packet, state.lastFragment, state.compressed, onExtensions_text.bind(this, state, callback));
}
function finish_text (mask, data) {
  var packet = this.unmask(mask, data, true) || new Buffer(0);
  var state = clone(this.state);
  this.messageHandlers.push(messageHandler_text.bind(this, packet, state));
  this.flush();
  this.endPacket();
}
Receiver.prototype.start_1 = function (data) {
  // decode length
  var firstLength = data[1] & 0x7f;
  if (firstLength < 126) {
    if (this.maxPayloadExceeded(firstLength)){
      this.error('Maximumpayload exceeded in compressed text message. Aborting...', 1009);
      return;
    }
    getData_text.call(this, firstLength);
  }
  else if (firstLength == 126) {
    this.expectHeader(2, onHeader2_text.bind(this));
  }
  else if (firstLength == 127) {
    this.expectHeader(8, onHeader8_text.bind(this));
  }
}
/**
 * Data handling methods
 */
function onHeader2_data (data) {
  var length = readUInt16BE.call(data, 0);
  if (this.maxPayloadExceeded(length)){
    this.error('Max payload exceeded in compressed text message. Aborting...', 1009);
    return;
  }
  getData_data.call(this, length);
}
function onHeader4_data (length, data) {
  this.expectData(length, onDataFromHeader4_data.bind(this, data));
}
function onHeader8_data (data) {
  if (readUInt32BE.call(data, 0) != 0) {
    this.error('packets with length spanning more than 32 bit is currently not supported', 1008);
    return;
  }
  var length = readUInt32BE.call(data, 4, true);
  if (this.maxPayloadExceeded(length)){
    this.error('Max payload exceeded in compressed text message. Aborting...', 1009);
    return;
  }
  getData_data.call(this, length);
}
function onDataFromHeader4_data (mask, data) {
  finish_data.call(this, mask, data);
}
function onData_data (data) {
  finish_data.call(this, null, data);
}
function getData_data (length) {
  if (this.state.masked) {
    this.expectHeader(4, onHeader4_data.bind(this, length));
  }
  else {
    this.expectData(length, onData_data.bind(this));
  }
}
function onExtensions_data (state, callback, err, buffer) {
  if (err) {
    if(err.type===1009){
        return this.error('Max payload exceeded in compressed binary message. Aborting...', 1009);
    }
    return this.error(err.message, 1007);
  }
  if (buffer != null) {
    if( this.maxPayload==0 || (this.maxPayload > 0 && (this.currentMessageLength + buffer.length) < this.maxPayload) ){
      this.currentMessage.push(buffer);
    }
    else{
        this.currentMessage=null;
        this.currentMessage = [];
        this.currentMessageLength = 0;
        this.error(new Error('Maximum payload exceeded'), 1009);
        return;
    }
    this.currentMessageLength += buffer.length;
  }
  if (state.lastFragment) {
    var messageBuffer = Buffer.concat(this.currentMessage);
    this.currentMessage = [];
    this.currentMessageLength = 0;
    this.onbinary(messageBuffer, {masked: state.masked, buffer: messageBuffer});
  }
  callback();
}
function messageHandler_data (packet, state, callback) {
  this.applyExtensions(packet, state.lastFragment, state.compressed, onExtensions_data.bind(this, state, callback));
}
function finish_data (mask, data) {
  var packet = this.unmask(mask, data, true) || new Buffer(0);
  var state = clone(this.state);
  this.messageHandlers.push(messageHandler_data.bind(this, packet, state));
  this.flush();
  this.endPacket();
}
Receiver.prototype.start_2 = function (data) {
  // decode length
  var firstLength = data[1] & 0x7f;
  if (firstLength < 126) {
      if (this.maxPayloadExceeded(firstLength)){
        this.error('Max payload exceeded in compressed text message. Aborting...', 1009);
        return;
      }
    getData_data.call(this, firstLength);
  }
  else if (firstLength == 126) {
    this.expectHeader(2, onHeader2_data.bind(this));
  }
  else if (firstLength == 127) {
    this.expectHeader(8, onHeader8_data.bind(this));
  }
}
/**
 * Close handling methods
 */
function onHeader4_close (length, data) {
  this.expectData(length, onDataFromHeader4_close.bind(this, data));
}
function onDataFromHeader4_close (mask, data) {
  finish_close.call(this, mask, data);
}
function onData_close (data) {
  finish_close.call(this, null, data);
}
function messageHandler_close (data, state) {
  if (data && data.length == 1) {
    this.error('close packets with data must be at least two bytes long', 1002);
    return;
  }
  var code = data && data.length > 1 ? readUInt16BE.call(data, 0) : 1000;
  if (!ErrorCodes.isValidErrorCode(code)) {
    this.error('invalid error code', 1002);
    return;
  }
  var message = '';
  if (data && data.length > 2) {
    var messageBuffer = data.slice(2);
    if (!isValidUTF8(messageBuffer)) {
      this.error('invalid utf8 sequence', 1007);
      return;
    }
    message = messageBuffer.toString('utf8');
  }
  this.onclose(code, message, {masked: state.masked});
  this.reset();
}
function getData_close (length) {
  if (this.state.masked) {
    this.expectHeader(4, onHeader4_close.bind(this, length));
  }
  else {
    this.expectData(length, onData_close.bind(this));
  }
}
function finish_close (mask, data) {
  data = this.unmask(mask, data, true);

  var state = clone(this.state);
  this.messageHandlers.push(messageHandler_close.bind(this, data, state));
  this.flush();
}
Receiver.prototype.start_8 = function (data) {
  if (this.state.lastFragment == false) {
    this.error('fragmented close is not supported', 1002);
    return;
  }

  // decode length
  var firstLength = data[1] & 0x7f;
  if (firstLength < 126) {
    getData_close.call(this, firstLength);
  }
  else {
    this.error('control frames cannot have more than 125 bytes of data', 1002);
  }
}
/**
 * Ping handling methods
 */
function onHeader4_ping (length, data) {
  var mask = data;
  this.expectData(length, onDataFromHeader4_ping.bind(this, data));
}
function onDataFromHeader4_ping (mask, data) {
  finish_ping.call(this, mask, data);
}
function onData_ping (data) {
  finish_ping.call(this, null, data);
}
function messageHandler_ping (data, state, callback) {
  this.onping(data, {masked: state.masked, binary: true});
  callback();
}
function getData_ping (length) {
  if (this.state.masked) {
    this.expectHeader(4, onHeader4_ping.bind(this, length));
  }
  else {
    this.expectData(length, onData_ping.bind(this));
  }
}
function finish_ping (mask, data) {
  data = this.unmask(mask, data, true);
  var state = clone(this.state);
  this.messageHandlers.push(messageHandler_ping.bind(this, data, state));
  this.flush();
  this.endPacket();
}
Receiver.prototype.start_9 = function (data) {
  if (this.state.lastFragment == false) {
    this.error('fragmented ping is not supported', 1002);
    return;
  }

  // decode length
  var firstLength = data[1] & 0x7f;
  if (firstLength < 126) {
    getData_ping.call(this, firstLength);
  }
  else {
    this.error('control frames cannot have more than 125 bytes of data', 1002);
  }
}
/**
 * Pong handling methods
 */
function onHeader4_pong (length, data) {
  this.expectData(length, onDataFromHeader4_pong.bind(this, data));
}
function onDataFromHeader4_pong (mask, data) {
  finish_pong.call(this, mask, data);
}
function onData_pong (data) {
  finish_pong.call(this, null, data);
}
function messageHandler_pong (data, state, callback) {
  this.onpong(data, {masked: state.masked, binary: true});
  callback();
}
function getData_pong (length) {
  if (this.state.masked) {
    this.expectHeader(4, onHeader4_pong.bind(this, length));
  }
  else {
    this.expectData(length, onData_pong.bind(this));
  }
}
function finish_pong (mask, data) {
  data = this.unmask(mask, data, true);
  var state = clone(this.state);
  this.messageHandlers.push(messageHandler_pong.bind(this, data, state));
  this.flush();
  this.endPacket();
}
Receiver.prototype.start_10 = function (data) {
  if (this.state.lastFragment == false) {
    this.error('fragmented pong is not supported', 1002);
    return;
  }

  // decode length
  var firstLength = data[1] & 0x7f;
  if (firstLength < 126) {
    getData_pong.call(this, firstLength);
  }
  else {
    this.error('control frames cannot have more than 125 bytes of data', 1002);
  }
}
