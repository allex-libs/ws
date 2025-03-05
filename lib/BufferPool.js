/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

var util = require('util');

function noop () {}

function defaultGrowStrategy (db, size) {
  return db.used + size;
}

function BufferPool(initialSize, growStrategy, shrinkStrategy) {
  if (this instanceof BufferPool === false) {
    throw new TypeError("Classes can't be function-called");
  }

  if (typeof initialSize === 'function') {
    shrinkStrategy = growStrategy;
    growStrategy = initialSize;
    initialSize = 0;
  }
  else if (typeof initialSize === 'undefined') {
    initialSize = 0;
  }
  this._growStrategy = (growStrategy || defaultGrowStrategy).bind(null, this);
  this._shrinkStrategy = shrinkStrategy || initialSize;
  this._buffer = null;
  this._offset = 0;
  this.used = 0;
  this._changeFactor = 0;
  this.size = 0;
  setBuffer(this, initialSize ? Buffer.alloc(initialSize) : null);
}

BufferPool.prototype.destroy = function () {
  this._changeFactor = null;
  this.used = null;
  this._offset = null;
  this._buffer = null;
  this._shrinkStrategy = null;
  this._growStrategy = null;
};

function setBuffer (bp, buff) {
  bp._buffer = buff;
  bp.size = Buffer.isBuffer(buff) ? buff.length : 0;
}

BufferPool.prototype.get = function(length) {
  if (this._buffer == null || this._offset + length > this._buffer.length) {
    var newBuf = Buffer.alloc(this._growStrategy(length));
    setBuffer(this, newBuf);
    this._offset = 0;
  }
  this.used += length;
  var buf = this._buffer.slice(this._offset, this._offset + length);
  this._offset += length;
  return buf;
}

function lenForShrink (bp) {
  if ('number' === typeof bp._shrinkStrategy) {
    return bp._shrinkStrategy;
  }
  return bp._shrinkStrategy(bp);
}

BufferPool.prototype.reset = function(forceNewBuffer) {
  var len = lenForShrink(this);
  if (len < this.size) this._changeFactor -= 1;
  if (forceNewBuffer || this._changeFactor < -2) {
    this._changeFactor = 0;
    setBuffer(this, len ? Buffer.alloc(len) : null);
  }
  this._offset = 0;
  this.used = 0;
}

module.exports = BufferPool;
