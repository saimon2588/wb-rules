// rule engine runtime
var _WbRules = {
  requireCompleteCells: 0,
  timers: {},
  aliases: {},

  CronEntry: function (spec) {
    if (typeof spec != "string")
      throw new Error("invalid cron spec");
    this.spec = spec;
  },

  IncompleteCellCaught: (function () {
    function IncompleteCellCaught(cellName) {
      this.name = "IncompleteCellCaught";
      this.message = "incomplete cell encountered: " + cellName;
    }
    IncompleteCellCaught.prototype = Object.create(Error.prototype);
    return IncompleteCellCaught;
  })(),

  autoload: function (target, acquire, setValue) {
    return new Proxy(target, {
      get: function (o, name) {
        if (!(name in o)) {
          o[name] = acquire(name, o);
        }
        return o[name];
      },
      set: function (o, name, value) {
        throw new Error("setting unsupported proxy value: " + name);
      }
    });
  },

  wrapDevice: function (name) {
    var cells = {};
    function ensureCell (dev, name) {
      return cells.hasOwnProperty(name) ?
        cells[name] :
        cells[name] = _wbCellObject(dev, name);
    }
    return new Proxy(_wbDevObject(name), {
      get: function (dev, name) {
        var cell = ensureCell(dev, name);
        if (_WbRules.requireCompleteCells && !cell.isComplete())
          throw new _WbRules.IncompleteCellCaught(name);
        return cell.value().v;
      },
      set: function (dev, name, value) {
        ensureCell(dev, name).setValue({ v: value });
      }
    });
  },

  parseCellRef: function parseCellRef (cellRef) {
    var m = cellRef.match(/([^\/]+)+\/([^\/]+)+$/);
    if (!m)
      throw new Error("invalid cell reference");
    return {
      device: m[1],
      control: m[2]
    };
  },

  defineAlias: function (name, cellRef) {
    if (!name || !cellRef)
      throw new Error("invalid alias definition");
    var ref = _WbRules.parseCellRef(cellRef);
    _WbRules.aliases[name] = cellRef;
    var d = null;
    Object.defineProperty(
      (function () { return this; })(),
      name,
      {
        configurable: true,
        get: function () {
          if (!d)
            d = dev[ref.device];
          return d[ref.control];
        },
        set: function (value) {
          if (!d)
            d = dev[ref.device];
          d[ref.control] = value;
        }
      });
  },

  defineRule: function (name, def) {
    debug("defineRule: " + name);
    if (typeof name != "string" || typeof def != "object")
      throw new Error("invalid rule definition");

    function wrapConditionFunc (f, incompleteValue) {
      var conv = typeof incompleteValue == "boolean" ?
            function (v) { return !!v; } : function (v) { return v; };
      return function () {
        _WbRules.requireCompleteCells++;
        try {
          return conv(f.apply(d, arguments));
        } catch (e) {
          if (e instanceof _WbRules.IncompleteCellCaught) {
            debug("skipping rule due to incomplete cell " + name + ": " + e);
            return incompleteValue;
          }
          throw e;
        } finally {
          _WbRules.requireCompleteCells--;
        }
      };
    }

    var d = Object.create(def);
    function transformWhenChangedItem (item) {
      if (typeof item == "string") {
        if (item.indexOf("/") >= 0)
          return item;
        if (!_WbRules.aliases.hasOwnProperty(item))
          throw new Error("invalid cell alias in whenChanged: " + item);
        return _WbRules.aliases[item];
      }
      if (typeof item != "function")
        throw new Error("invalid whenChanged spec");
      return wrapConditionFunc(item, undefined);
    }

    // when: cron("...") is converted to cron: "..."
    if (def.hasOwnProperty("when") && def.when instanceof _WbRules.CronEntry) {
      def._cron = def.when.spec;
      delete def.when;
    }

    Object.keys(def).forEach(function (k) {
      var orig = d[k];
      switch(k) {
      case "readonly":
        d[k] = !!d[k]; // avoid type cast error on the Go side
        break;
      case "asSoonAs":
      case "when":
        d[k] = wrapConditionFunc(orig, false);
        break;
      case "whenChanged":
        if (Array.isArray(orig))
          d[k] = orig.map(transformWhenChangedItem);
        else
          d[k] = transformWhenChangedItem(orig);
        break;
      case "then":
        d[k] = function (options) {
          if (options) {
            if (options.hasOwnProperty("device"))
              // TBD: pass options.oldValue right after newValue here -- for consistency
              orig.call(d, options.newValue, options.device, options.cell);
            else
              orig.call(d, options.newValue);
          } else
            orig.call(d);
        };
      }
    });
    _wbDefineRule(name, d);
  },

  startTimer: function startTimer(name, ms, periodic) {
    debug("starting timer: " + name);
    _wbStartTimer(name, ms, !!periodic);
  }
};

var dev = _WbRules.autoload({}, _WbRules.wrapDevice);
var timers = _WbRules.autoload(_WbRules.timers, function (name) {
  return {
    get firing() {
      return _wbCheckCurrentTimer(name);
    },
    stop: function () {
      _wbStopTimer(name);
    }
  };
});

var defineRule = _WbRules.defineRule;

function startTimer (name, ms) {
  _WbRules.startTimer(name, ms, false);
}

function startTicker (name, ms) {
  _WbRules.startTimer(name, ms, true);
}

function setTimeout(callback, ms) {
  return _wbStartTimer(callback, ms, false);
}

function setInterval(callback, ms) {
  return _wbStartTimer(callback, ms, true);
}

function clearTimeout(id) {
  _wbStopTimer(id);
}

function clearInterval(id) {
  clearTimeout(id);
}

function spawn(cmd, args, options) {
  if (typeof options == "function")
    options = {
      exitCallback: options,
      captureOutput: false,
      captureErrorOutput: false
    };
  else if (!options)
    options = {
      exitCallback: null,
      captureOutput: false,
      captureErrorOutput: false
    };
  else {
    if (!options.hasOwnProperty("captureOutput"))
      options.captureOutput = false;
    if (!options.hasOwnProperty("captureErrorOutput"))
      options.captureErrorOutput = false;
  }

  if (options.input != null)
    options.input = "" + options.input;

  _wbSpawn([cmd].concat(args || []), options.exitCallback ? function (args) {
    try {
      options.exitCallback(
        args.exitStatus,
        options.captureOutput ? args.capturedOutput : null,
        args.capturedErrorOutput
      );
    } catch (e) {
      log("error running command callback for " + cmd + ": " + (e.stack || e));
    }
  } : null, !!options.captureOutput, !!options.captureErrorOutput, options.input);
}

function runShellCommand(cmd, options) {
  spawn("/bin/sh", ["-c", cmd], options);
}

var defineAlias = _WbRules.defineAlias;

String.prototype.format = function () {
  var args = [ this ];
  for (var i = 0; i < arguments.length; ++i)
    args.push(arguments[i]);
  return format.apply(null, args);
};

function cron(spec) {
  return new _WbRules.CronEntry(spec);
}

var Notify = (function (){
  var _smsQueue = [],
      _smsBusy = false;

  function _advanceSmsQueue () {
    if (!_smsQueue.length)
      return;
    var next = _smsQueue.shift();
    next();
  }

  return {
    sendEmail: function sendEmail (to, subject, text) {
      debug("sending email to {}: {}", to, subject);
      runShellCommand("/usr/sbin/sendmail '{}'".format(to), {
        captureErrorOutput: true,
        captureOutput: true,
        input: "Subject: {}\n\n{}".format(subject, text),
        exitCallback: function exitCallback (exitCode, capturedOutput, capturedErrorOutput) {
          if (exitCode != 0)
            log.error("error sending email to {}:\n{}\n{}", to, capturedOutput, capturedErrorOutput);
        }
      });
    },

    sendSMS: function sendSMS (to, text) {
      var doSend = function () {
        _smsBusy = true;
        debug("sending sms to {}: {}", to, text);
        runShellCommand("wb-gsm restart_if_broken && gammu sendsms TEXT '{}' -unicode".format(to), {
          captureErrorOutput: true,
          captureOutput: true,
          input: text,
          exitCallback: function (exitCode, capturedOutput, capturedErrorOutput) {
            _smsBusy = false;
            if (exitCode != 0)
              log.error("error sending sms to {}:\n{}\n{}", to, capturedOutput, capturedErrorOutput);
            _advanceSmsQueue();
          }
        });
      };

      if (_smsBusy) {
        debug("queueing sms to {}: {}", to, text);
        _smsQueue.push(doSend);
      } else
        doSend();
    }
  };
})();

var Alarms = (function () {
  var recipientTypes = {
    email: function getEmailSendFunc (src) {
      if (!src.hasOwnProperty("to"))
        throw new Error("email recipient without 'to'");
      var subject = src.hasOwnProperty("subject") ? "" + src.subject : "{}";
      return function sendEmailWrapper (text) {
        Notify.sendEmail(src.to, maybeFormat(subject, text), text);
      };
    },

    sms: function getSMSSendFunc (src) {
      if (!src.hasOwnProperty("to"))
        throw new Error("sms recipient without 'to'");
      return function sendSMSWrapper (text) {
        Notify.sendSMS(src.to, text);
      };
    }
  };

  function maybeFormat(text, arg) {
    return text.indexOf("{}") >= 0 ? text.format(arg) : text;
  }

  function getSendFunc (src) {
    if (!src || typeof src != "object" || !src.hasOwnProperty("type") ||
        !recipientTypes.hasOwnProperty(src.type))
      throw new Error("invalid recipient spec: %s", JSON.stringify(src));
    return recipientTypes[src.type](src);
  }

  var seq = 1;

  function loadAlarm (alarmSrc, notify) {
    if (!alarmSrc || typeof alarmSrc != "object" || !alarmSrc.hasOwnProperty("cell"))
      throw new Error("invalid alarm definition");

    function checkHasNumKey (key) {
      if (!alarmSrc.hasOwnProperty(key))
        return false;

      if (typeof alarmSrc[key] != "number")
        throw new Error("{}: {}: number expected!".format(JSON.stringify(alarmSrc), key));

      return true;
    }

    var ref = _WbRules.parseCellRef(alarmSrc.cell);
    var namePrefix = "__alarm{}__{}__".format(seq++, alarmSrc.cell),
        hasExpectedValue = alarmSrc.hasOwnProperty("expectedValue"),
        hasMinValue = alarmSrc.hasOwnProperty("minValue"),
        hasMaxValue = alarmSrc.hasOwnProperty("maxValue"),
        alarmMessage = alarmSrc.alarmMessage ||
          alarmSrc.cell + (hasExpectedValue ? " has unexpected value = {}" : "is out of bounds, value = {}"),
        noAlarmMessage = alarmSrc.noAlarmMessage ||
          alarmSrc.cell + " is back to normal, value = {}",
        min, max, interval = null;

    if (hasExpectedValue) {
        if (hasMinValue || hasMaxValue)
          throw new Error("{}: cannot have both expectedValue and minValue/maxValue"
                          .format(JSON.stringify(alarmSrc)));
    } else {
      if (!hasMinValue && !hasMaxValue)
        throw new Error("{}: must specify either expectedValue or value range"
                        .format(JSON.stringify(alarmSrc)));
      min = hasMinValue ? alarmSrc.minValue : -Infinity;
      max = hasMaxValue ? alarmSrc.maxValue : Infinity;
    }

    if (alarmSrc.hasOwnProperty("interval")) {
      // !(alarmSrc.interval > 0) covers NaN case
      if (typeof alarmSrc.interval != "number" || !(alarmSrc.interval > 0))
        throw new Error("invalid alarm interval");
      interval = alarmSrc.interval * 1000;
    }

    var d = null;
    function cellValue () {
      if (!d)
        d = dev[ref.device];
      return d[ref.control];
    }

    var wasActive = false, intervalId = null;

    function notifyAboutActiveAlarm() {
      notify(maybeFormat(alarmMessage, cellValue()));
    }

    defineRule(namePrefix + "activate", {
      asSoonAs: hasExpectedValue ? function () {
        // log("cv={}; ev={}", JSON.stringify(cellValue()), JSON.stringify(alarmSrc.expectedValue));
        return cellValue() != alarmSrc.expectedValue;
      } : function () {
        // log("cv={}; min={}, max={}", JSON.stringify(cellValue()), min, max);
        return cellValue() < min || cellValue() > max;
      },
      then: function () {
        if (wasActive)
          return;
        wasActive = true;
        notifyAboutActiveAlarm();
        if (interval !== null)
          intervalId = setInterval(notifyAboutActiveAlarm, interval);
      }
    });

    defineRule(namePrefix + "deactivate", {
      asSoonAs: hasExpectedValue ? function () {
        return cellValue() == alarmSrc.expectedValue;
      } : function () {
        return cellValue() >= min && cellValue() <= max;
      },
      then: function () {
        if (!wasActive)
          return;

        wasActive = false;
        if (intervalId != null) {
          clearInterval(intervalId);
          intervalId = null;
        }

        notify(maybeFormat(noAlarmMessage, cellValue()));
      }
    });
  }

  function doLoad (src) {
    if (!src.hasOwnProperty("recipients") || !Array.isArray(src.recipients) || !src.recipients.length)
      throw new Error("no (proper) recipients specified");

    if (!src.hasOwnProperty("alarms") || !Array.isArray(src.alarms) || !src.alarms.length)
      throw new Error("no (proper) alarms specified");

    var sendFuncs = src.recipients.map(getSendFunc);
    function notify (text) {
      sendFuncs.forEach(function (sendFunc) { sendFunc.call(null, text); });
    }

    src.alarms.forEach(function (alarmSrc) {
      loadAlarm(alarmSrc, notify);
    });
  }

  return {
    load: function (src) {
      return doLoad(typeof src == "string" ? readConfig(src) : src);
    }
  };
})();
