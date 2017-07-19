
/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

function createWebSocket(lib) {
  'use strict';
  var url = require('url')
    , util = require('util')
    , http = require('http')
    , https = require('https')
    , crypto = require('crypto')
    , stream = require('stream')
    , Ultron = require('ultron')
    , Sender = require('./Sender')
    , Receiver = require('./Receiver')
    , SenderHixie = require('./Sender.hixie')
    , ReceiverHixie = require('./Receiver.hixie')
    , Extensions = require('./Extensions')
    , PerMessageDeflate = require('./PerMessageDeflate')
    , EventEmitter = require('events').EventEmitter;

  /**
   * Constants
   */

  // Default protocol version

  var protocolVersion = 13;

  // Close timeout

  var closeTimeout = 30 * 1000; // Allow 30 seconds to terminate the connection cleanly

  /**
   * WebSocket implementation
   *
   * @constructor
   * @param {String} address Connection address.
   * @param {String|Array} protocols WebSocket protocols.
   * @param {Object} options Additional connection options.
   * @api public
   */
  function WebSocket(address, protocols, options) {
    if (this instanceof WebSocket === false) {
      return new WebSocket(address, protocols, options);
    }

    EventEmitter.call(this);

    if (protocols && !Array.isArray(protocols) && 'object' === typeof protocols) {
      // accept the "options" Object as the 2nd argument
      options = protocols;
      protocols = null;
    }

    if ('string' === typeof protocols) {
      protocols = [ protocols ];
    }

    if (!Array.isArray(protocols)) {
      protocols = [];
    }

    this._socket = null;
    this._ultron = null;
    this._closeReceived = false;
    this.bytesReceived = 0;
    this.readyState = null;
    this.supports = {};
    this.extensions = {};
    this._binaryType = 'nodebuffer';
    this._queue = null;

    if (Array.isArray(address)) {
      initAsServerClient.apply(this, address.concat(options));
    } else {
      initAsClient.apply(this, [address, protocols, options]);
    }
  }

  /**
   * Inherits from EventEmitter.
   */
  util.inherits(WebSocket, EventEmitter);

  /**
   * Ready States
   */
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function each(state, index) {
      WebSocket.prototype[state] = WebSocket[state] = index;
  });

  /**
   * Gracefully closes the connection, after sending a description message to the server
   *
   * @param {Object} data to be sent to the server
   * @api public
   */
  WebSocket.prototype.close = function close(code, data) {
    if (this.readyState === WebSocket.CLOSED) return;

    if (this.readyState === WebSocket.CONNECTING) {
      this.readyState = WebSocket.CLOSED;
      this.removeAllListeners();
      return;
    }

    if (this.readyState === WebSocket.CLOSING) {
      if (this._closeReceived && this._isServer) {
        this.terminate();
      }
      return;
    }

    try {
      this.readyState = WebSocket.CLOSING;
      this._closeCode = code;
      this._closeMessage = data;
      var mask = !this._isServer;
      this._sender.close(code, data, mask, onSenderClosed.bind(this));
    } catch (e) {
      this.emit('error', e);
    }
  };

  function onSenderClosed(err) {
    if (err) this.emit('error', err);

    if (this._closeReceived && this._isServer) {
      this.terminate();
    } else {
      // ensure that the connection is cleaned up even when no response of closing handshake.
      clearTimeout(this._closeTimer);
      this._closeTimer = setTimeout(cleanupWebsocketResources.bind(this, true), closeTimeout);
    }
  }

  /**
   * Pause the client stream
   *
   * @api public
   */
  WebSocket.prototype.pause = function pauser() {
    if (this.readyState !== WebSocket.OPEN) throw new Error('not opened');

    return this._socket.pause();
  };

  /**
   * Sends a ping
   *
   * @param {Object} data to be sent to the server
   * @param {Object} Members - mask: boolean, binary: boolean
   * @param {boolean} dontFailWhenClosed indicates whether or not to throw if the connection isnt open
   * @api public
   */
  WebSocket.prototype.ping = function ping(data, options, dontFailWhenClosed) {
    if (this.readyState !== WebSocket.OPEN) {
      if (dontFailWhenClosed === true) return;
      throw new Error('not opened');
    }

    options = options || {};

    if (typeof options.mask === 'undefined') options.mask = !this._isServer;

    this._sender.ping(data, options);
  };

  /**
   * Sends a pong
   *
   * @param {Object} data to be sent to the server
   * @param {Object} Members - mask: boolean, binary: boolean
   * @param {boolean} dontFailWhenClosed indicates whether or not to throw if the connection isnt open
   * @api public
   */
  WebSocket.prototype.pong = function(data, options, dontFailWhenClosed) {
    if (this.readyState !== WebSocket.OPEN) {
      if (dontFailWhenClosed === true) return;
      throw new Error('not opened');
    }

    options = options || {};

    if (typeof options.mask === 'undefined') options.mask = !this._isServer;

    this._sender.pong(data, options);
  };

  /**
   * Resume the client stream
   *
   * @api public
   */
  WebSocket.prototype.resume = function resume() {
    if (this.readyState !== WebSocket.OPEN) throw new Error('not opened');

    return this._socket.resume();
  };

  /**
   * Sends a piece of data
   *
   * @param {Object} data to be sent to the server
   * @param {Object} Members - mask: boolean, binary: boolean, compress: boolean
   * @param {function} Optional callback which is executed after the send completes
   * @api public
   */

  WebSocket.prototype.send = function send(data, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }

    if (this.readyState !== WebSocket.OPEN) {
      if (typeof cb === 'function') cb(new Error('not opened'));
      else throw new Error('not opened');
      return;
    }

    if (!data) data = '';
    if (this._queue) {
      this._queue.push(this.send.bind(this, data, options, cb));
      return;
    }

    options = options || {};
    options.fin = true;

    if (typeof options.binary === 'undefined') {
      options.binary = (data instanceof ArrayBuffer || data instanceof Buffer ||
        data instanceof Uint8Array ||
        data instanceof Uint16Array ||
        data instanceof Uint32Array ||
        data instanceof Int8Array ||
        data instanceof Int16Array ||
        data instanceof Int32Array ||
        data instanceof Float32Array ||
        data instanceof Float64Array);
    }

    if (typeof options.mask === 'undefined') options.mask = !this._isServer;
    if (typeof options.compress === 'undefined') options.compress = true;
    if (!this.extensions[PerMessageDeflate.extensionName]) {
      options.compress = false;
    }

    var readable = typeof stream.Readable === 'function'
      ? stream.Readable
      : stream.Stream;

    if (data instanceof readable) {
      startQueue(this);

      sendStream(this, data, options, onStreamSent.bind(this, cb));
    } else {
      this._sender.send(data, options, cb);
    }
  };

  function onStreamSent (cb, error) {
    process.nextTick(executeQueueSends.bind(null, this));

    if (typeof cb === 'function') cb(error);
  }

  /**
   * Streams data through calls to a user supplied function
   *
   * @param {Object} Members - mask: boolean, binary: boolean, compress: boolean
   * @param {function} 'function (error, send)' which is executed on successive ticks of which send is 'function (data, final)'.
   * @api public
   */
  WebSocket.prototype.stream = function stream(options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }

    if (typeof cb !== 'function') throw new Error('callback must be provided');

    if (this.readyState !== WebSocket.OPEN) {
      if (typeof cb === 'function') cb(new Error('not opened'));
      else throw new Error('not opened');
      return;
    }

    if (this._queue) {
      this._queue.push(this.stream.bind(this, options, cb));
      return;
    }

    options = options || {};

    if (typeof options.mask === 'undefined') options.mask = !this._isServer;
    if (typeof options.compress === 'undefined') options.compress = true;
    if (!this.extensions[PerMessageDeflate.extensionName]) {
      options.compress = false;
    }

    startQueue(this);

    process.nextTick(cb.bind(null, null, streamSend.bind(null, this, options, cb)));
  };

  function streamSend(instance, options, cb, data, final) {
    try {
      if (instance.readyState !== WebSocket.OPEN) throw new Error('not opened');
      options.fin = final === true;
      instance._sender.send(data, options);
      if (!final) process.nextTick(cb.bind(null, null, streamSend.bind(null, instance, options, cb)));
      else executeQueueSends(instance);
    } catch (e) {
      if (typeof cb === 'function') cb(e);
      else {
        instance._queue = null;
        instance.emit('error', e);
      }
    }
    instance = null;
    options = null;
    cb = null;
  }


  /**
   * Immediately shuts down the connection
   *
   * @api public
   */
  WebSocket.prototype.terminate = function terminate() {
    if (this.readyState === WebSocket.CLOSED) return;

    if (this._socket) {
      this.readyState = WebSocket.CLOSING;

      // End the connection
      try { this._socket.end(); }
      catch (e) {
        // Socket error during end() call, so just destroy it right now
        cleanupWebsocketResources.call(this, true);
        return;
      }

      // Add a timeout to ensure that the connection is completely
      // cleaned up within 30 seconds, even if the clean close procedure
      // fails for whatever reason
      // First cleanup any pre-existing timeout from an earlier "terminate" call,
      // if one exists.  Otherwise terminate calls in quick succession will leak timeouts
      // and hold the program open for `closeTimout` time.
      if (this._closeTimer) { clearTimeout(this._closeTimer); }
      this._closeTimer = setTimeout(cleanupWebsocketResources.bind(this, true), closeTimeout);
    } else if (this.readyState === WebSocket.CONNECTING) {
      cleanupWebsocketResources.call(this, true);
    }
  };

  /**
   * Expose bufferedAmount
   *
   * @api public
   */
  Object.defineProperty(WebSocket.prototype, 'bufferedAmount', {
    get: function get() {
      var amount = 0;
      if (this._socket) {
        amount = this._socket.bufferSize || 0;
      }
      return amount;
    }
  });

  /**
   * Expose binaryType
   *
   * This deviates from the W3C interface since ws doesn't support the required
   * default "blob" type (instead we define a custom "nodebuffer" type).
   *
   * @see http://dev.w3.org/html5/websockets/#the-websocket-interface
   * @api public
   */
  Object.defineProperty(WebSocket.prototype, 'binaryType', {
    get: function get() {
      return this._binaryType;
    },
    set: function set(type) {
      if (type === 'arraybuffer' || type === 'nodebuffer')
        this._binaryType = type;
      else
        throw new SyntaxError('unsupported binaryType: must be either "nodebuffer" or "arraybuffer"');
    }
  });

  /**
   * Emulates the W3C Browser based WebSocket interface using function members.
   *
   * @see http://dev.w3.org/html5/websockets/#the-websocket-interface
   * @api public
   */
  ['open', 'error', 'close', 'message'].forEach(function(method) {
    Object.defineProperty(WebSocket.prototype, 'on' + method, {
      /**
       * Returns the current listener
       *
       * @returns {Mixed} the set function or undefined
       * @api public
       */
      get: function get() {
        var listener = this.listeners(method)[0];
        return listener ? (listener._listener ? listener._listener : listener) : undefined;
      },

      /**
       * Start listening for events
       *
       * @param {Function} listener the listener
       * @returns {Mixed} the set function or undefined
       * @api public
       */
      set: function set(listener) {
        this.removeAllListeners(method);
        this.addEventListener(method, listener);
      }
    });
  });

  /**
   * Emulates the W3C Browser based WebSocket interface using addEventListener.
   *
   * @see https://developer.mozilla.org/en/DOM/element.addEventListener
   * @see http://dev.w3.org/html5/websockets/#the-websocket-interface
   * @api public
   */
  WebSocket.prototype.addEventListener = function(method, listener) {
    var target = this;

    function onMessage (data, flags) {
      if (flags.binary && this.binaryType === 'arraybuffer')
          data = new Uint8Array(data).buffer;
      listener.call(target, new MessageEvent(data, !!flags.binary, target));
    }

    function onClose (code, message) {
      listener.call(target, new CloseEvent(code, message, target));
    }

    function onError (event) {
      event.type = 'error';
      event.target = target;
      listener.call(target, event);
    }

    function onOpen () {
      listener.call(target, new OpenEvent(target));
    }

    if (typeof listener === 'function') {
      if (method === 'message') {
        // store a reference so we can return the original function from the
        // addEventListener hook
        onMessage._listener = listener;
        this.on(method, onMessage);
      } else if (method === 'close') {
        // store a reference so we can return the original function from the
        // addEventListener hook
        onClose._listener = listener;
        this.on(method, onClose);
      } else if (method === 'error') {
        // store a reference so we can return the original function from the
        // addEventListener hook
        onError._listener = listener;
        this.on(method, onError);
      } else if (method === 'open') {
        // store a reference so we can return the original function from the
        // addEventListener hook
        onOpen._listener = listener;
        this.on(method, onOpen);
      } else {
        this.on(method, listener);
      }
    }
  };

  /**
   * W3C MessageEvent
   *
   * @see http://www.w3.org/TR/html5/comms.html
   * @constructor
   * @api private
   */
  function MessageEvent(dataArg, isBinary, target) {
    this.type = 'message';
    this.data = dataArg;
    this.target = target;
    this.binary = isBinary; // non-standard.
  }

  /**
   * W3C CloseEvent
   *
   * @see http://www.w3.org/TR/html5/comms.html
   * @constructor
   * @api private
   */
  function CloseEvent(code, reason, target) {
    this.type = 'close';
    this.wasClean = (typeof code === 'undefined' || code === 1000);
    this.code = code;
    this.reason = reason;
    this.target = target;
  }

  /**
   * W3C OpenEvent
   *
   * @see http://www.w3.org/TR/html5/comms.html
   * @constructor
   * @api private
   */
  function OpenEvent(target) {
    this.type = 'open';
    this.target = target;
  }

  // Append port number to Host header, only if specified in the url
  // and non-default
  function buildHostHeader(isSecure, hostname, port) {
    var headerHost = hostname;
    if (hostname) {
      if ((isSecure && (port != 443)) || (!isSecure && (port != 80))){
        headerHost = headerHost + ':' + port;
      }
    }
    return headerHost;
  }

  /**
   * Entirely private apis,
   * which may or may not be bound to a sepcific WebSocket instance.
   */
  function initAsServerClient(req, socket, upgradeHead, options) {

    // expose state properties
    this.protocol = options.protocol || null;
    this.protocolVersion = options.protocolVersion || protocolVersion;
    this.extensions = options.extensions || {};
    this.supports.binary = (this.protocolVersion !== 'hixie-76');
    this.upgradeReq = req;
    this.readyState = WebSocket.CONNECTING;
    this._isServer = true;
    this.maxPayload = options.maxPayload || 0;
    // establish connection
    if (options.protocolVersion === 'hixie-76') {
      establishConnection.call(this, ReceiverHixie, SenderHixie, socket, upgradeHead);
    } else {
      establishConnection.call(this, Receiver, Sender, socket, upgradeHead);
    }
  }

  function initAsClient(address, protocols, options) {
    options = lib.extend({
      origin: null,
      protocolVersion: protocolVersion,
      host: null,
      headers: null,
      protocol: protocols.join(','),
      agent: null,

      // ssl-related options
      pfx: null,
      key: null,
      passphrase: null,
      cert: null,
      ca: null,
      ciphers: null,
      rejectUnauthorized: null,
      perMessageDeflate: true,
      localAddress: null
    }, options);

    if (options.protocolVersion !== 8 && options.protocolVersion !== 13) {
      throw new Error('unsupported protocol version');
    }

    // verify URL and establish http class
    var serverUrl = url.parse(address);
    var isUnixSocket = serverUrl.protocol === 'ws+unix:';
    if (!serverUrl.host && !isUnixSocket) throw new Error('invalid url');
    var isSecure = serverUrl.protocol === 'wss:' || serverUrl.protocol === 'https:';
    var httpObj = isSecure ? https : http;
    var port = serverUrl.port || (isSecure ? 443 : 80);
    var auth = serverUrl.auth;

    // prepare extensions
    var extensionsOffer = {};
    var perMessageDeflate;
    if (options.perMessageDeflate) {
      perMessageDeflate = new PerMessageDeflate(typeof options.perMessageDeflate !== true ? options.perMessageDeflate : {}, false);
      extensionsOffer[PerMessageDeflate.extensionName] = perMessageDeflate.offer();
    }

    // expose state properties
    this._isServer = false;
    this.url = address;
    this.protocolVersion = options.protocolVersion;
    this.supports.binary = (this.protocolVersion !== 'hixie-76');

    // begin handshake
    var key = new Buffer(options.protocolVersion + '-' + Date.now()).toString('base64');
    var shasum = crypto.createHash('sha1');
    shasum.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
    var expectedServerKey = shasum.digest('base64');

    var agent = options.agent;

    var headerHost = buildHostHeader(isSecure, serverUrl.hostname, port)

    var requestOptions = {
      port: port,
      host: serverUrl.hostname,
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Host': headerHost,
        'Sec-WebSocket-Version': options.protocolVersion,
        'Sec-WebSocket-Key': key
      }
    };

    // If we have basic auth.
    if (auth) {
      requestOptions.headers.Authorization = 'Basic ' + new Buffer(auth).toString('base64');
    }

    if (options.protocol) {
      requestOptions.headers['Sec-WebSocket-Protocol'] = options.protocol;
    }

    if (options.host) {
      requestOptions.headers.Host = options.host;
    }

    if (options.headers) {
      for (var header in options.headers) {
         if (options.headers.hasOwnProperty(header)) {
          requestOptions.headers[header] = options.headers[header];
         }
      }
    }

    if (Object.keys(extensionsOffer).length) {
      requestOptions.headers['Sec-WebSocket-Extensions'] = Extensions.format(extensionsOffer);
    }

    if (lib.isDefinedAndNotNull(options.pfx)
     || lib.isDefinedAndNotNull(options.key)
     || lib.isDefinedAndNotNull(options.passphrase)
     || lib.isDefinedAndNotNull(options.cert)
     || lib.isDefinedAndNotNull(options.ca)
     || lib.isDefinedAndNotNull(options.ciphers)
     || lib.isDefinedAndNotNull(options.rejectUnauthorized)) {

      if (lib.isDefinedAndNotNull(options.pfx)) requestOptions.pfx = options.pfx;
      if (lib.isDefinedAndNotNull(options.key)) requestOptions.key = options.key;
      if (lib.isDefinedAndNotNull(options.passphrase)) requestOptions.passphrase = options.passphrase;
      if (lib.isDefinedAndNotNull(options.cert)) requestOptions.cert = options.cert;
      if (lib.isDefinedAndNotNull(options.ca)) requestOptions.ca = options.ca;
      if (lib.isDefinedAndNotNull(options.ciphers)) requestOptions.ciphers = options.ciphers;
      if (lib.isDefinedAndNotNull(options.rejectUnauthorized)) requestOptions.rejectUnauthorized = options.rejectUnauthorized;

      if (!agent) {
          // global agent ignores client side certificates
          agent = new httpObj.Agent(requestOptions);
      }
    }

    requestOptions.path = serverUrl.path || '/';

    if (agent) {
      requestOptions.agent = agent;
    }

    if (isUnixSocket) {
      requestOptions.socketPath = serverUrl.pathname;
    }

    if (options.localAddress) {
      requestOptions.localAddress = options.localAddress;
    }

    if (options.origin) {
      if (options.protocolVersion < 13) requestOptions.headers['Sec-WebSocket-Origin'] = options.origin;
      else requestOptions.headers.Origin = options.origin;
    }

    var req = httpObj.request(requestOptions);

    req.on('error', onRequestError.bind(this));

    req.once('response', onRequestResponseOnce.bind(this, req));

    req.once('upgrade', onRequestUpgradeOnce.bind(this, expectedServerKey, options, perMessageDeflate, agent, req));

    req.end();
    this.readyState = WebSocket.CONNECTING;
  }

  function onRequestError(error) {
    this.emit('error', error);
    cleanupWebsocketResources.call(this, error);
  }

  function onRequestResponseOnce(req, res) {
    var error;

    if (!this.emit('unexpected-response', req, res)) {
      error = new Error('unexpected server response (' + res.statusCode + ')');
      req.abort();
      this.emit('error', error);
    }

    cleanupWebsocketResources.call(this, error);
    req = null;
  }

  function onRequestUpgradeOnce (expectedServerKey, options, perMessageDeflate, agent, req, res, socket, upgradeHead) {
    if (this.readyState === WebSocket.CLOSED) {
      // client closed before server accepted connection
      this.emit('close');
      this.removeAllListeners();
      socket.end();
      return;
    }

    var serverKey = res.headers['sec-websocket-accept'];
    if (typeof serverKey === 'undefined' || serverKey !== expectedServerKey) {
      this.emit('error', 'invalid server key');
      this.removeAllListeners();
      socket.end();
      return;
    }

    var serverProt = res.headers['sec-websocket-protocol'];
    var protList = (options.protocol || "").split(/, */);
    var protError = null;

    if (!options.protocol && serverProt) {
      protError = 'server sent a subprotocol even though none requested';
    } else if (options.protocol && !serverProt) {
      protError = 'server sent no subprotocol even though requested';
    } else if (serverProt && protList.indexOf(serverProt) === -1) {
      protError = 'server responded with an invalid protocol';
    }

    if (protError) {
      this.emit('error', protError);
      this.removeAllListeners();
      socket.end();
      return;
    } else if (serverProt) {
      this.protocol = serverProt;
    }

    var serverExtensions = Extensions.parse(res.headers['sec-websocket-extensions']);
    if (perMessageDeflate && serverExtensions[PerMessageDeflate.extensionName]) {
      try {
        perMessageDeflate.accept(serverExtensions[PerMessageDeflate.extensionName]);
      } catch (err) {
        this.emit('error', 'invalid extension parameter');
        this.removeAllListeners();
        socket.end();
        return;
      }
      this.extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
    }

    establishConnection.call(this, Receiver, Sender, socket, upgradeHead);

    // perform cleanup on http resources
    req.removeAllListeners();
    req = null;
    agent = null;
  }

  function establishConnection(ReceiverClass, SenderClass, socket, upgradeHead) {
    var handlerobj = {called: false, handler: null}
      , fhb = firstHandler.bind(this, handlerobj, socket, upgradeHead, realHandler.bind(this));

    handlerobj.handler = fhb;
    socket.setTimeout(0);
    socket.setNoDelay(true);
    if (this._ultron) {
      this._ultron.destroy();
    }
    this._ultron = new Ultron(socket);
    this._receiver = new ReceiverClass(this.extensions,this.maxPayload);
    this._socket = socket;

    // socket cleanup handlers
    this._ultron.on('end', cleanupWebsocketResources.bind(this));
    this._ultron.on('close', cleanupWebsocketResources.bind(this));
    this._ultron.on('error', cleanupWebsocketResources.bind(this));

    this._ultron.on('data', fhb);

    // if data was passed along with the http upgrade,
    // this will schedule a push of that on to the receiver.
    // this has to be done on next tick, since the caller
    // hasn't had a chance to set event handlers on this client
    // object yet.
    process.nextTick(fhb);

    // receiver event handlers
    this._receiver.ontext = onTextReceived.bind(this);

    this._receiver.onbinary = onBinaryReceived.bind(this);

    this._receiver.onping = onPingReceived.bind(this);

    this._receiver.onpong = onPongReceived.bind(this);

    this._receiver.onclose = onClose.bind(this);

    this._receiver.onerror = onError.bind(this);

    // finalize the client
    this._sender = new SenderClass(socket, this.extensions);
    this._sender.on('error', onSenderError.bind(this));

    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  // subsequent packets are pushed straight to the receiver
  function realHandler(data) {
    this.bytesReceived += data.length;
    this._receiver.add(data);
  }

  function onTextReceived(data, flags) {
    flags = flags || {};

    this.emit('message', data, flags);
  }

  function onBinaryReceived(data, flags) {
    flags = flags || {};

    flags.binary = true;
    this.emit('message', data, flags);
  }

  function onPingReceived(data, flags) {
    flags = flags || {};

    this.pong(data, {
      mask: !this._isServer,
      binary: flags.binary === true
    }, true);

    this.emit('ping', data, flags);
  }

  function onPongReceived(data, flags) {
    this.emit('pong', data, flags || {});
  }

  function onClose(code, data, flags) {
    flags = flags || {};

    this._closeReceived = true;
    this.close(code, data);
  }

  function onError(reason, errorCode) {
    // close the connection when the receiver reports a HyBi error code
    this.close(typeof errorCode !== 'undefined' ? errorCode : 1002, '');
    this.emit('error', (reason instanceof Error) ? reason : (new Error(reason)));
  }


  function onSenderError(error) {
    this.close(1002, '');
    this.emit('error', error);
  }

  // ensure that the upgradeHead is added to the receiver
  function firstHandler(handlerobj, socket, upgradeHead, _realHandler, data) {
    if (!handlerobj) {
      return;
    }
    if (handlerobj.called || this.readyState === WebSocket.CLOSED) {
      handlerobj.handler = null;
      handlerobj = null;
      socket = null;
      upgradeHead = null;
      _realHandler = null;
      return;
    }

    handlerobj.called = true;
    socket.removeListener('data', handlerobj.handler);
    this._ultron.on('data', _realHandler);

    if (upgradeHead && upgradeHead.length > 0) {
      _realHandler(upgradeHead);
      upgradeHead = null;
    }

    if (data) _realHandler(data);
    handlerobj.handler = null;
    handlerobj = null;
    socket = null;
    upgradeHead = null;
    _realHandler = null;
  }


  function startQueue(instance) {
    instance._queue = instance._queue || [];
  }

  function executeQueueSends(instance) {
    var queue = instance._queue;
    if (!queue) return;

    instance._queue = null;
    for (var i = 0, l = queue.length; i < l; ++i) {
      queue[i]();
    }
  }

  function sendStream(instance, stream, options, cb) {
    stream.on('data', function incoming(data) {
      if (instance.readyState !== WebSocket.OPEN) {
        if (typeof cb === 'function') cb(new Error('not opened'));
        else {
          instance._queue = null;
          instance.emit('error', new Error('not opened'));
        }
        return;
      }

      options.fin = false;
      instance._sender.send(data, options);
    });

    stream.on('end', function end() {
      if (instance.readyState !== WebSocket.OPEN) {
        if (typeof cb === 'function') cb(new Error('not opened'));
        else {
          instance._queue = null;
          instance.emit('error', new Error('not opened'));
        }
        return;
      }

      options.fin = true;
      instance._sender.send(null, options);

      if (typeof cb === 'function') cb(null);
    });
  }

  function onSocketErrorFinal () {
    try { this.destroy(); }
    catch (e) {}
  }

  function cleanupWebsocketResources(error) {
    if (this.readyState === WebSocket.CLOSED) return;

    this.readyState = WebSocket.CLOSED;

    clearTimeout(this._closeTimer);
    this._closeTimer = null;

    // If the connection was closed abnormally (with an error), or if
    // the close control frame was not received then the close code
    // must default to 1006.
    if (error || !this._closeReceived) {
      this._closeCode = 1006;
    }
    this.emit('close', this._closeCode || 1000, this._closeMessage || '');

    if (this._socket) {
      if (this._ultron) this._ultron.destroy();
      this._socket.on('error', onSocketErrorFinal.bind(this));

      try {
        if (!error) this._socket.end();
        else this._socket.destroy();
      } catch (e) { /* Ignore termination errors */ }

      this._socket = null;
      this._ultron = null;
    }

    if (this._sender) {
      this._sender.removeAllListeners();
      this._sender = null;
    }

    if (this._receiver) {
      this._receiver.cleanup();
      this._receiver = null;
    }

    if (this.extensions[PerMessageDeflate.extensionName]) {
      this.extensions[PerMessageDeflate.extensionName].cleanup();
    }

    this.extensions = null;

    this.removeAllListeners();
    this.on('error', function onerror() {}); // catch all errors after this
    this._queue = null;
  }

  WebSocket.buildHostHeader = buildHostHeader;

  return WebSocket;
}

module.exports = createWebSocket;

