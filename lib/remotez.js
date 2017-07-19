var EventEmitter = require('events'),
  cp = require('child_process'),
  Path = require('path'),
  childz = cp.fork(Path.join(__dirname, 'zrunner.js')),
  util = require('util'),
  flators = new Map();


var DEFAULT_WINDOW_BITS = 15;
var DEFAULT_MEM_LEVEL = 8;
var _id = 0;

childz.on('message', onChildZ);

function onChildZ (msg) {
  var flator = flators.get(msg.id);
  if (!flator) {
    return;
  }
  if (msg.data) {
    flator.emit('data', Buffer.from(msg.data));
  } else if (msg.error) {
    flator.emit('error', new Error(msg.error));
  } else if (msg.flush) {
    flator.doFlush();
  }
}

function Flator (maxwindowbits) {
  EventEmitter.call(this);
  this._zid = ++_id;
  this.maxWindowBits = 'number' === typeof maxWindowBits ? maxWindowBits : DEFAULT_WINDOW_BITS;
  flators.set(this._zid, this);
  this.flushcb = null;
}
util.inherits(Flator, EventEmitter);
Flator.prototype.destroy = function () {
  flators.delete(this._zid);
  this.doFlush();
  this.maxWindowBits = null;
  this._zid = null;
  console.log(flators.size, 'flators left');
};

Flator.prototype.write = function (data) {
  childz.send({
    type: this.constructor.name,
    data: data,
    id: this._zid,
    maxwindowbits: this.maxWindowBits,
    memlevel: this.memLevel
  });
};
Flator.prototype.flush = function (cb) {
  this.flushcb = cb;
  childz.send({
    id: this._zid,
    flush: true
  });
};
Flator.prototype.doFlush = function () {
  var flushcb = this.flushcb;
  this.flushcb = null;
  if (flushcb) {
    flushcb();
  }
};
Flator.prototype.close = function () {
  if (this._zid) {
    childz.send({
      id: this._zid,
      close: true
    });
  }
  this.destroy();
};

function Deflator (maxwindowbits, memlevel) {
  Flator.call(this, maxwindowbits);
  this.memLevel = memlevel || DEFAULT_MEM_LEVEL;
}
util.inherits(Deflator, Flator);

function Inflator (maxwindowbits) {
  Flator.call(this, maxwindowbits);
}
util.inherits(Inflator, Flator);

function createDeflateRaw (maxWindowBits, memlevel) {
  return new Deflator(maxWindowBits, memlevel);
}

function createInflateRaw (maxWindowBits) {
  return new Inflator(maxWindowBits);
}

module.exports = {
  createDeflateRaw: createDeflateRaw,
  createInflateRaw: createInflateRaw
};
