var zlib = require('./localz'),
  flators = new Map();

function createDeflator (msg) {
  var defkey = msg.id;
    deflator = flators.get(defkey);
  if (!deflator) {
    deflator = zlib.createDeflateRaw(msg.maxwindowbits, msg.memlevel);
    flators.set(defkey, deflator);
    deflator.on('error', sendError.bind(null, msg.id)).on('data', sendData.bind(null, msg.id));
  }
  return deflator;
}

function createInflator (msg) {
  var defkey = msg.id;
    inflator = flators.get(defkey);
  if (!inflator) {
    inflator = zlib.createInflateRaw(msg.maxwindowbits);
    flators.set(defkey, inflator);
    inflator.on('error', sendError.bind(null, msg.id)).on('data', sendData.bind(null, msg.id));
  }
  return inflator;
}

function sendData (id, data) {
  doSend({
    id: id,
    data: data
  });
}

function sendError (id, error) {
  doSend({
    id: id,
    error: error.message
  });
}

function sendFlush (id) {
  doSend({
    id: id,
    flush: true
  });
}

function doSend (obj) {
  if (process.connected) {
    process.send(obj);
  }
}

process.on('message', function (msg) {
  var flator;
  switch(msg.type) {
    case 'Deflator':
      flator = createDeflator(msg);
      break;
    case 'Inflator':
      flator = createInflator(msg);
      break;
  }
  if (msg.data) {
    flator.write(Buffer.from(msg.data));
  } else if (msg.flush) {
    flators.get(msg.id).flush(sendFlush.bind(null, msg.id));
  } else if (msg.close) {
    flator = flators.get(msg.id);
    if (flator) {
      if (!flator.close) {
        console.log(flator.constructor.name, 'has no close?');
      }
      flator.removeAllListeners();
      flator.close();
    }
    flators.delete(msg.id);
  }
});
