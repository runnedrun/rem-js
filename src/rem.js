/*

Rem: REST easy.
A flexible HTTP library for using the web like an API.

Reference:
http://roy.gbiv.com/untangled/2008/rest-apis-must-be-hypertext-driven

*/

/**
 * Utilities
 */

function callable (obj) {
  var f = function () {
    return f.call.apply(f, arguments);
  };
  f.__proto__ = obj;
  return f;
};

function clone (obj) {
  return JSON.parse(JSON.stringify(obj));
}

function augment (c, b) {
  for (var k in b) {
    if (Object.prototype.hasOwnProperty.call(b, k) && b[k] != null) {
      c[k] = b[k];
    }
  }
  return c;
}

function safeJSONStringify (data) {
  return JSON.stringify(data).replace(/[\u007f-\uffff]/g, function (c) {
    return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
  });
}

var Middleware = (function () {

  function Middleware () { }

  Middleware.prototype.use = function (callback) {
    (this._middleware || (this._middleware = [])).push(callback);
    return this;
  };

  Middleware.prototype.middleware = function () {
    var args = Array.prototype.slice.call(arguments), next = args.pop();
    var fns = (this._middleware || []).slice();
    function nextCallback() {
      if (fns.length == 0) {
        next();
      } else {
        fns.shift().apply(this, args.concat([nextCallback.bind(this)]));
      }
    }
    nextCallback.call(this);
    return this;
  };

  return Middleware;

})();


/**
 * Environment
 */

var envtype = (typeof module !== 'undefined' && module.exports) ? 'node' : 'browser';

// Require the rem environment-specific code.
if (envtype == 'node') {
  var env = require('./node/env');
}


/**
 * Module
 */

var rem = (envtype == 'node') ? exports : this.rem = {};

// Configuration.
rem.userAgent = 'Mozilla/5.0 (compatible; REMbot/1.0; +http://remlib.org/)';

rem.env = env;

/**
 * Data formats.
 */

rem.serializer = {
  json: function (data) {
    return safeJSONStringify(data);
  },

  form: function (data) {
    return env.qs.stringify(data);
  }
};

rem.parsers = {
  stream: function (res, next) {
    next(res);
  },

  binary: function (res, next) {
    env.consumeStream(res, next);
  },

  text: function (res, next) {
    env.consumeStream(res, function (data) {
      // Strip BOM signatures.
      next(String(data).replace(/^\uFEFF/, ''));
    });
  },

  json: function (res, next) {
    rem.parsers.text(res, function (data) {
      try {
        data = JSON.parse(String(data));
      } catch (e) {
        console.error('Invalid JSON:', data);
        throw e;
      }
      next(data);
    });
  },

  xml: function (res, next) {
    rem.parsers.text(res, function (data) {
      try {
        env.parseXML(res, next);
      } catch (e) {
        console.error('Invalid XML:', data);
        throw e;
      }
      next(data);
    });
  }
};


/** 
 * URL model
 * protocol://auth@hostname:port/pathname?query#hash
 */

/** @constructor */
function URL (str) {
  this.protocol = undefined;
  this.auth = undefined;
  this.hostname = undefined;
  this.port = undefined;
  this.pathname = undefined;
  this.query = {};
  this.hash = undefined;
  if (str) {
    this.parse(str);
  }
}

URL.prototype.getHost = function () {
  return this.hostname && (this.hostname + (this.port ? ':' + this.port : ''));
};

URL.prototype.getPath = function () {
  return this.pathname
    + (env.qs.stringify(this.query) ? '?' + env.qs.stringify(this.query) : '')
    + (this.hash ? '#' + encodeURIComponent(this.hash) : '');
};

URL.prototype.toString = function () {
  return env.formatURL(this);
};

URL.prototype.augment = function (obj) {
  this.protocol = obj.protocol || this.protocol;
  this.auth = obj.auth || this.auth;
  this.hostname = obj.hostname || this.hostname;
  this.port = obj.port || this.port;
  this.pathname = obj.pathname || this.pathname;
  augment(this.query, obj.query); // special
  this.hash = obj.hash || this.hash;
};

URL.prototype.parse = function (str) {
  this.augment(env.parseURL(str));
};

/**
 * ClientRequest functions
 */

/** @constructor */
function ClientRequest () {
  this.method = 'GET';
  this.headers = {};
  this.url = new URL();
  this.body = null;
}

ClientRequest.prototype.setHeader = function (key, value) {
  this.headers[String(key).toLowerCase()] = value;
}

ClientRequest.prototype.getHeader = function (key) {
  return this.headers[String(key).toLowerCase()];
}

ClientRequest.prototype.removeHeader = function (key) {
  return delete this.headers[String(key).toLowerCase()];
}

ClientRequest.prototype.setBody = function (type, body) {
  // Expand payload shorthand.
  if (typeof body == 'object' && !env.isList(body)) {
    if (type == 'form' || type == 'application/x-www-form-urlencoded') {
      type = 'application/x-www-form-urlencoded';
      body = rem.serializer.form(body);
    }
    if (type == 'json' || type == 'application/json') {
      type = 'application/json';
      body = rem.serializer.json(body);
    }
  }

  this.setHeader('Content-Length', body.length);
  this.setHeader('Content-Type', type);
  this.body = body;
}

ClientRequest.prototype.send = function (agent, next) {
  return env.sendRequest(this, agent, next);
}


/**
 * An HTTP route.
 */

var Route = (function () {

  function Route (req, defaultBodyMime, callback) {
    this.req = req;
    this.defaultBodyMime = defaultBodyMime || 'json';
    this.callback = callback;
  }

  Route.prototype.get = function (query, next) {
    if (arguments.length == 1) next = query, query = null;
    this.req.method = 'GET';
    augment(this.req.url.query, query || {});
    return this.callback(next);
  };

  Route.prototype.head = function (query, next) {
    if (arguments.length == 1) next = query, query = null;
    this.req.method = 'HEAD';
    augment(this.req.url.query, query || {});
    return this.callback(next);
  };

  Route.prototype.del = function (next) {
    this.req.method = 'DELETE';
    return this.callback(next);
  };

  Route.prototype.post = function (mime, body, next) {
    if (arguments.length == 2) next = body, body = mime, mime = this.defaultBodyMime;
    if (arguments.length == 1) next = mime, body = null, mime = this.defaultBodyMime;
    this.req.method = 'POST';
    this.req.setBody(this.req, mime, body)
    return this.callback(next);
  };

  Route.prototype.patch = function (mime, body, next) {
    if (arguments.length == 2) next = body, body = mime, mime = this.defaultBodyMime;
    if (arguments.length == 1) next = mime, body = null, mime = this.defaultBodyMime;
    this.req.method = 'PATCH';
    this.req.setBody(this.req, mime, body)
    return this.callback(next);
  };

  Route.prototype.put = function (mime, body, next) {
    if (arguments.length == 2) next = body, body = mime, mime = this.defaultBodyMime;
    if (arguments.length == 1) next = mime, body = null, mime = this.defaultBodyMime;
    this.req.method = 'PUT';
    this.req.setBody(this.req, mime, body)
    return this.callback(next);
  };

  return Route;

})();


/**
 * Client
 */

var Client = (function () {

  env.inherits(Client, Middleware);

  function Client (options) {
    // Defaults.
    this.options = { format: 'json' };
    if (options) {
      this.configure(options);
    }

    // User agent.
    this.use(function (req, next) {
      req.headers['user-agent'] = req.headers['user-agent'] || rem.userAgent;
      next();
    });
  }

  Client.prototype.configure = function (options) {
    augment(this.options, options);

    return this;
  };

  // Invoke as method.
  function invoke (api, segments, send) {
    // Combine query arguments and URL path segments.
    var query = typeof segments[segments.length - 1] == 'object' ? segments.pop() : {};
    var url = ((segments[0] || '').indexOf('//') != -1 ? segments.shift() : (segments.length ? '/' : ''))
      + (segments.length ? env.joinPath.apply(null, segments) : '');
    url = new URL(url);
    augment(url.query, query);

    var req = new ClientRequest();
    req.url.augment(url);
    return new Route(req, api.options.uploadFormat, function (next) {
      api.middleware(req, function () {
        // Debug capability.
        if (api.debug) {
          console.error(String(req.method).green, String(req.url).grey,
            req.body ? ('[body: ' + (req.body.length ? req.body.length + ' bytes' : 'stream') + ']').grey : '');
        }

        // Consume streams.
        // TODO: Let us pipe() into the request. We can't now, due to OAuth.
        send(req, next);
      });

      // TODO
      //return duplex_stream_for_request
    });
  }

  // Formats

  for (var format in rem.parsers) {
    (function (format) {
      Client.prototype[format] = function () {
        return invoke(this, Array.prototype.slice.call(arguments), function (req, next) {
          this.send(req, debugResponse(this, function (err, res) {
            //this.middleware('response', req, res, function () {
              rem.parsers[format](res, function (data) {
                next && next.call(this, res.statusCode >= 400 ? res.statusCode : 0, data, res);
              });
            //});
          }.bind(this)));
        }.bind(this));
      }
    })(format);
  }

  Client.prototype.call = function () {
    return invoke(this, Array.prototype.slice.call(arguments), function (req, next) {
      this.send(req, debugResponse(this, function (err, res) {
        //this.middleware('response', req, res, function () {
          this.parseStream(req, res, function (data) {
            next && next.call(this, res.statusCode >= 400 ? res.statusCode : 0, data, res);
          }.bind(this));
        //}.bind(this));
      }.bind(this)));
    }.bind(this));
  };

  function debugResponse (api, next) {
    return function (err, res) {
      if (api.debug) {
        if (res) {
          console.error(String(res.statusCode).green,
            ('[type: ' + String(res.headers['content-type']) + ']').grey,
            ('[body: ' + String(res.headers['content-length']) + ']').grey);
        } else {
          console.error('ERROR'.green, String(err).grey)
        }
      }

      next.apply(this, arguments);
    };
  }

  Client.prototype.parseStream = function (req, res, next) {
    rem.parsers[this.options.format](res, next);
  };

  Client.prototype.send = function (opts, next) {
    var req = opts.send(this.agent, next);
    if (opts.body != null) {
      req.write(opts.body);
    }
    req.end();
  };

  // Throttling.

  Client.prototype.throttle = function (rate) {
    // Unthrottle with api.throttle(null)
    if (rate == null) {
      this.send = this._send || this.send;
      return this;
    }

    var queue = [];
    setInterval(function () {
      var fn = queue.shift();
      if (fn) {
        fn();
      }
    }, 1000 / rate)

    // Replace send function.
    if (!this._send) {
      this._send = this.send;
    }
    this.send = function () {
      var args = arguments;
      queue.push(function () {
        this._send.apply(this, args);
      }.bind(this));
    };

    return this;
  };

  // Return.

  return Client;

})();

// Manifest Client.

var ManifestClient = (function () {

  env.inherits(ManifestClient, Client);

  function ManifestClient (manifest, options) {
    // Define manifst.
    this.manifest = manifest;
    this.manifest.configuration = this.manifest.configuration || ['key', 'secret'];

    // Initialize client and options.
    Client.call(this, options);

    // Response. Expand payload shorthand.
    this.use(function (req, next) {
      if (this.manifest.base) {
        // Determine base that matches the path name.
        var pathname = req.url.pathname.replace(/^(?!\/)/, '/')
        // Bases can be fixed or an array of (pattern, base) tuples.
        if (env.isList(this.manifest.base)) {
          var base = '';
          this.manifest.base.some(function (tuple) {
            if (pathname.match(new RegExp(tuple[0]))) {
              base = tuple[1];
              return true;
            }
          });
        } else {
          var base = String(this.manifest.base);
        }
        
        // Update the request with base.
        // TODO check for matching base and use it.
        if (base && (req.url.protocol || req.url.hostname)) {
          throw new Error('Full URL request does not match API base URL: ' + String(req.url));
        }
        req.url.augment(new URL(base)); // Incorporate base.
        req.url.pathname = env.joinPath(req.url.pathname, pathname); // Append path.
      }
      // Route root pathname.
      if (this.manifest.basepath) {
        req.url.pathname = this.manifest.basepath + req.url.pathname;
      }
      // Route suffix.
      if (this.manifest.suffix) {
        req.url.pathname += this.manifest.suffix;
      }

      // Route configuration parameters.
      if (this.manifest.configParams) {
        var params = this.manifest.configParams;
        for (var key in params) {
          req.url.query[key] = this.options[this.manifest.configParams[key]];
        }
      }

      // Route static parameters.
      if (this.manifest.params) {
        var params = this.manifest.params;
        for (var key in params) {
          req.url.query[key] = params[key];
        }
      }

      next();
    }.bind(this));
  }

  ManifestClient.prototype.configure = function (options) {
    augment(this.options, options);

    // Load format-specific options from the manifest.
    if (this.manifest.formats) {
      if (!this.manifest.formats[this.options.format]) {
        throw new Error("Format \"" + this.options.format + "\" is not explicitly defined in this manifest. Please specify an available format this API supports.");
      }
      augment(this.manifest, this.manifest.formats[this.options.format]);
    }
    // Upload format.
    this.options.uploadFormat = this.options.uploadFormat || this.manifest.uploadFormat;

    return this;
  };

  // Prompt.

  ManifestClient.prototype.promptAuthentication = function (opts, next) {
    if (!next) next = opts, opts = {};
    env.promptAuthentication(rem, this, opts, next);
    return this;
  };

  ManifestClient.prototype.promptConfiguration = function (next) {
    env.promptConfiguration(rem, this, next);
    return this;
  };

  ManifestClient.prototype.prompt = function (opts, next) {
    if (!next) next = opts, opts = {};
    this.promptConfiguration(function () {
      this.promptAuthentication(opts, function () {
        console.error('');
        next.apply(this, arguments);
      });
    }.bind(this));
    return this;
  };

  return ManifestClient;

})();


/**
 * Public API.
 */

rem.Client = Client;
rem.ManifestClient = ManifestClient;

rem.createClient = function (manifest, opts) {
  if (typeof manifest == 'string') {
    manifest = { base: manifest };
  }
  var api = callable(new ManifestClient(manifest, opts));
  rem.env.oncreate(api);
  return api;
};

function createFromManifest (manifest, path, version, opts) {
  version = version = '*' ? Number(version) || '*' : '*';
  if (!manifest || !manifest[version]) {
    if (version == '*' && manifest) {
      var version = Object.keys(manifest).sort().pop();
      if (!manifest[version]) {
        throw new Error('Unable to find API ' + JSON.stringify(path) + ' version ' + JSON.stringify(Number(version)) + '. For the latest API, use "*".');
      }
    } else if (manifest) {
      throw new Error('Unable to find API ' + JSON.stringify(path) + ' version ' + JSON.stringify(Number(version)) + '. For the latest API, use "*".');
    } else {
      throw new Error('Unable to find API ' + JSON.stringify(path) + '.');
    }
  }
  manifest = manifest[version];
  manifest.version = version;
  return rem.createClient(manifest).configure(opts);
}

rem.connect = function (path, version, opts) {
  return createFromManifest(env.lookupManifestSync(path), path, version, opts);
};

rem.connectAsync = function (path, version, opts, next) {
  if (!next) {
    next = opts;
    opts = {};
  }
  env.lookupManifest(path, function (err, manifest) {
    if (err) {
      next(err);
    } else {
      next(null, createFromManifest(manifest, path, version, opts));
    }
  })
};

/**
 * Default client request methods.
 */

var defaultClient = new rem.Client();

Object.keys(rem.parsers).forEach(function (format) {
  rem[format] = function () {
    return defaultClient[format].apply(defaultClient, arguments);
  };
});

/**
 * Polling
 */

/*
function jsonpath (obj, keys) {
  keys.split('.').filter(String).forEach(function (key) {
    obj = obj && obj[key];
  });
  return obj;
}

rem.poll = function (endpoint, opts, callback) {
  // opts is an optional argument with a 'interval', 'root', and 'date' param.
  callback = typeof callback == 'function' ? callback : opts;
  opts = typeof opts == 'object' ? opts : {};
  var interval = opts.interval || 1000;
  var ARRAY_ROOT = opts.root || '';
  var DATE_KEY = opts.date || 'created_at';

  var latest = null;
  setInterval(function () {
    endpoint.get(function (err, json) {
      if (json && jsonpath(json, ARRAY_ROOT)) {
        var root = jsonpath(json, ARRAY_ROOT);
        for (var i = 0; i < root.length; i++) {
          if (latest && new Date(jsonpath(root[i], DATE_KEY)) <= latest) {
            break;
          }
        }
        if (i > 0) {
          var items = root.slice(0, i);
          callback(null, items);
          latest = new Date(jsonpath(items[0], DATE_KEY));
        }
      }
    });
  }, interval);
}
*/

/**
 * Includes
 */

if (envtype == 'node') {
  // Authentication methods.
  require('./node/oauth');
  require('./node/basic');
  //require('./node/aws');
}
