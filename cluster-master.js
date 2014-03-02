// Set up a cluster and set up resizing and such.

var cluster = require("cluster")
, quitting = false
, restarting = false
, path = require("path")
, clusterSize = 0
, env
, os = require("os")
, onmessage
, repl = require('repl')
, replAddressPath = process.env.CLUSTER_MASTER_REPL || 'cluster-master-socket'
, net = require('net')
, fs = require('fs')
, util = require('util')
, minRestartAge = 2000
, delayBeforeKill = 2000
, delayBeforeRestartWhenMinRestartAge = 2000
, delayBetweenShutdownAndDisconnect = undefined
, delayForRestartChecking = 2000
, danger = false

exports = module.exports = clusterMaster
exports.restart = restart
exports.resize = resize
exports.quitHard = quitHard
exports.quit = quit

var logger_function = function() {
  console.error.apply(console, arguments);
}

var debugStreams = {}
function debug () {
  logger_function.apply(this, arguments)

  var msg = util.format.apply(util, arguments)
  Object.keys(debugStreams).forEach(function (s) {
    try {
      // if the write fails, just remove it.
      debugStreams[s].write(msg + '\n')
      if (debugStreams[s].repl) debugStreams[s].repl.displayPrompt()
    } catch (e) {
      delete debugStreams[s]
    }
  })
}


function clusterMaster (config) {
  if (typeof config === "string") config = { exec: config }

  if (!config.exec) {
    throw new Error("Must define a 'exec' script")
  }

  if (!cluster.isMaster) {
    throw new Error("ClusterMaster answers to no one!\n"+
                    "(don't run in a cluster worker script)")
  }

  if (cluster._clusterMaster) {
    throw new Error("This cluster has a master already")
  }

  cluster._clusterMaster = module.exports

  if (typeof config.repl !== 'undefined') replAddressPath = config.repl  // allow null and false

  onmessage = config.onMessage || config.onmessage

  if (config.logger) {
    logger_function = config.logger
  }

  clusterSize = config.size || os.cpus().length

  minRestartAge = config.minRestartAge || minRestartAge

  delayBeforeKill = config.delayBeforeKill || delayBeforeKill

  delayBeforeRestartWhenMinRestartAge = config.delayBeforeRestartWhenMinRestartAge || delayBeforeRestartWhenMinRestartAge

  delayBetweenShutdownAndDisconnect = config.delayBetweenShutdownAndDisconnect || delayBetweenShutdownAndDisconnect

  delayForRestartChecking = config.delayForRestartChecking || delayForRestartChecking

  env = config.env

  var masterConf = { exec: path.resolve(config.exec) }
  if (config.silent) masterConf.silent = true
  if (config.env) masterConf.env = config.env
  if (config.args) masterConf.args = config.args

  cluster.setupMaster(masterConf)

  if (config.signals !== false) {
    // sighup/sigint listeners
    setupSignals()
  }

  forkListener()

  // now make it the right size
  debug((replAddressPath) ? 'resize and then setup repl' : 'resize')
  resize()
  setupRepl()
}

function select (field) {
  return Object.keys(cluster.workers).map(function (k) {
    return [k, cluster.workers[k][field]]
  }).reduce(function (set, kv) {
    set[kv[0]] = kv[1]
    return set
  }, {})
}

function setupRepl () {
  if (!replAddressPath) return  // was disabled

  debug('setup repl')
  var socket = null
  var socketAddress = undefined
  if (typeof replAddressPath === 'string') {
    socket = path.resolve(replAddressPath)
  } else if (typeof replAddressPath === 'number') {
    socket = replAddressPath
    if (!isNaN(socket)) socket = +socket
  } else if (replAddressPath.address && replAddressPath.port) {
    socket = replAddressPath.port
    socketAddress = replAddressPath.address
  }
  var connections = 0

  if (typeof socket === 'string') {
    fs.unlink(socket, function (er) {
      if (er && er.code !== 'ENOENT') throw er
      startRepl()
    })
  } else {
    startRepl()
  }

  function startRepl () {
    logger_function('starting repl on '+socket+'=');
    process.on('exit', function() {
      try { fs.unlinkSync(socket) } catch (er) {}
    })
    var sockId = 0
    var replServer = net.createServer(function (sock) {
      connections ++
      replEnded = false

      sock.id = sockId ++
      debugStreams['repl-' + sockId] = sock

      sock.write('Starting repl #' + sock.id)
      var r = repl.start({
        prompt: 'ClusterMaster (`help` for cmds) ' + process.pid + ' ' + sock.id + '> ',
        input: sock,
        output: sock,
        terminal: true,
        useGlobal: false,
        ignoreUndefined: true
      })

      var helpCommands = [
        'help        - display these commands',
        'repl        - access the REPL',
        'resize(n)   - resize the cluster to `n` workers',
        'restart(cb) - gracefully restart workers, cb is optional',
        'stop()      - gracefully stop workers and master',
        'kill()      - forcefully kill workers and master',
        'cluster     - node.js cluster module',
        'size        - current cluster size',
        'connections - number of REPL connections to master',
        'workers     - current workers',
        'select(fld) - map of id to field (from workers)',
        'pids        - map of id to pids',
        'ages        - map of id to worker ages',
        'states      - map of id to worker states',
        'debug(a1)   - output `a1` to stdout and all REPLs',
        'sock        - this REPL socket',
        '.exit       - close this connection to the REPL'
      ]

      var context = {
        help: helpCommands,
        repl: r,
        resize: resize,
        restart: restart,
        stop: quit,
        kill: quitHard,
        cluster: cluster,
        get size () {
          return clusterSize
        },
        get connections () {
          return connections
        },
        get workers () {
          var p = select('pid')
          var s = select('state')
          var a = select('age')
          return Object.keys(cluster.workers).map(function (k) {
            return new Worker({ id: k, pid: p[k], state: s[k], age: a[k] })
          })
        },
        select: select,
        get pids () {
          return select('pid')
        },
        get ages () {
          return select('age')
        },
        get states () {
          return select('state')
        },
        // like 'wall'
        debug: debug,
        sock: sock
      }
      var desc = Object.getOwnPropertyNames(context).map(function (n) {
        return [n, Object.getOwnPropertyDescriptor(context, n)]
      }).reduce(function (set, kv) {
        set[kv[0]] = kv[1]
        return set
      }, {})
      Object.defineProperties(r.context, desc)

      sock.repl = r

      r.on('end', function () {
        connections --
        replEnded = true
        if (!ended) sock.end()
      })

      sock.on('end', end)
      sock.on('close', end)
      sock.on('error', end)

      ended = false
      function end () {
        if (ended) return
        ended = true
        if (!replEnded) r.rli.close()
        delete debugStreams['repl-' + sockId]
      }

    })

    if (socketAddress) {
      replServer.listen(socket, socketAddress, function () {
        debug('ClusterMaster repl listening on '+socketAddress+':'+socket)
      })
    } else {
      replServer.listen(socket,  function () {
        debug('ClusterMaster repl listening on '+socket)
      })
    }
  }
}

function Worker (d) {
  this.id = d.id
  this.pid = d.pid
  this.state = d.state
  this.age = d.age
}

Worker.prototype.disconnect = function () {
  cluster.workers[this.id].disconnect()
}

Worker.prototype.kill = function () {
  process.kill(this.pid)
}

function checkIfDisconnected(worker) {
  setTimeout(function() {
    if (worker.process.connected) {
      debug("Worker %j, doesnt not disconnect, forcefully killing", worker.id)
      worker.process.kill("SIGKILL")
    }
    else {
    }
  }, delayBeforeKill)
}
function disconnectWorker(worker) {
  if (delayBetweenShutdownAndDisconnect) {
    debug('Sending shutdown signal')
    worker.send('shutdown');
    setTimeout(function() {
      if (worker.process.connected) {
        worker.disconnect();
        checkIfDisconnected(worker)
      }
    }, delayBetweenShutdownAndDisconnect);
  }
  else {
    worker.disconnect();
    checkIfDisconnected(worker)
  }
}

var resize_timeout_in_danger;

var wait_listening_cb = []

function forkListener () {
  cluster.on("fork", function (worker) {
    worker.birth = Date.now()
    Object.defineProperty(worker, 'age', { get: function () {
      return Date.now() - this.birth
    }, enumerable: true, configurable: true })
    worker.pid = worker.process.pid
    var id = worker.id
    debug("Worker %j setting up", id)
    if (onmessage) worker.on("message", onmessage)
    var disconnectTimer

    worker.on("exit", function () {
      clearTimeout(disconnectTimer)
      if (wait_listening_cb.length > 0) {
        cluster.removeListener('listening', wait_listening_cb.shift())
      }

      if (!worker.suicide) {
        debug("Worker %j exited abnormally", id)
        // don't respawn right away if it's a very fast failure.
        // otherwise server crashes are hard to detect from monitors.
        if (worker.age < minRestartAge) {
          debug("Worker %j died too quickly, danger", id)
          danger = true
          // still try again in a few seconds, though.
          if (!resize_timeout_in_danger && !restarting) {
            resize_timeout_in_danger = setTimeout(function() {
              resize_timeout_in_danger = undefined;
              resize()
            }, delayBeforeRestartWhenMinRestartAge)
          }
          return
        }
      } else {
        debug("Worker %j exited", id)
      }

      if (Object.keys(cluster.workers).length < clusterSize && !resizing) {
        resize()
      }
    })

    worker.on("disconnect", function () {
      debug("Worker %j disconnect", id)
      // give it 1 second to shut down gracefully, or kill
      if (!worker.process.exitCode) {
        disconnectTimer = setTimeout(function () {
          debug("Worker %j, forcefully killing", id)
          worker.process.kill("SIGKILL")
        }, delayBeforeKill)
      }
    })
  })
}

function restart (cb) {
  if (restarting) {
    debug("Already restarting.  Cannot restart yet.")
    return cb && cb("Already restarting.  Cannot restart yet.")
  }

  if (!quitting) {
    debug('Restarting all workers')
  }

  restarting = true

  // graceful restart.
  // all the existing workers get killed, and this
  // causes new ones to be spawned.  If there aren't
  // already the intended number, then fork new extras.
  var current = Object.keys(cluster.workers)
  , length = current.length
  , reqs = clusterSize - length

  var i = 0

  // if we're resizing, then just kill off a few.
  if (reqs !== 0) {
    debug('resize %d -> %d, change = %d',
                  current.length, clusterSize, reqs)

    return resize(clusterSize, function () {
      debug('resize cb')
      length = clusterSize
      graceful()
    })
  }

  // all the current workers, kill and then wait for a
  // new one to spawn before moving on.
  graceful()
  function graceful () {
    debug("graceful %d of %d", i, length)
    if (i >= current.length) {
      debug("graceful completion")
      restarting = false
      return cb && cb()
    }

    var first = (i === 0)
    , id = current[i++]
    , worker = cluster.workers[id]

    if (quitting) {
      if (worker && worker.process.connected) {
        disconnectWorker(worker)
      }
      return graceful()
    }

    var new_worker

    // start a new one. if it lives for 2 seconds, kill the worker.
    if (first) {
      var timer
      var listening_cb = function (newbie) {
        if (newbie === new_worker) {
          timer = setTimeout(function () {
            cluster.removeListener('exit', skeptic)
            if (worker && worker.process.connected) {
              disconnectWorker(worker)
            }
            debug('First worker ok, continuing restart')
            graceful()
          }, delayForRestartChecking)
        }
      }
      cluster.once('listening', listening_cb)
      cluster.once('exit', skeptic)
      function skeptic (worker) {
        if (worker === new_worker) {
          debug('New worker ' + worker.pid + ' died quickly. Aborting restart.')
          restarting = false
          cluster.removeListener('listening', listening_cb)
          clearTimeout(timer)
        }
      }
    } else {
      cluster.once('listening', function (newbie) {
        if (worker && worker.process.connected) {
          disconnectWorker(worker)
        }
      })
      graceful()
    }

    new_worker = cluster.fork(env)
  }
}



var resizing = false
var resizeCbs = []
function resize (n, cb_) {
  if (typeof n === 'function') cb_ = n, n = clusterSize

  if (cb_)
    resizeCbs.push(cb_)

  if (resizing)
    return

  function cb() {
    logger_function.apply('done resizing');

    resizing = false
    var q = resizeCbs.slice(0)
    resizeCbs.length = 0
    q.forEach(function(c) {
      c()
    })
    if (clusterSize !== Object.keys(cluster.workers).length) {
      if (danger && clusterSize === 0) {
        debug('DANGER! something bad has happened')
        process.exit(1)
      } else {
        danger = true
        debug('DANGER! wrong number of workers')
        setTimeout(resize, 1000)
      }
    } else {
      danger = false
    }
  }

  if (n >= 0) clusterSize = n
  var current = Object.keys(cluster.workers)
  , c = current.length
  , req = clusterSize - c

  // avoid angry "listening" listeners
  cluster.setMaxListeners(clusterSize * 2)

  if (c === clusterSize) {
    resizing = false
    return cb()
  }

  var thenCnt = 0
  function then () {
    thenCnt ++
    return then2
  }
  function then2 () {
    if (--thenCnt === 0) {
      resizing = false
      return cb()
    }
  }

  // make us have the right number of them.
  if (req > 0) while (req -- > 0) {
    debug('resizing up', req)
    var listening_cb = function() {
      wait_listening_cb.shift();
      then()();
    }
    wait_listening_cb.push(listening_cb);
    cluster.once('listening', listening_cb)
    cluster.fork(env)
  } else for (var i = clusterSize; i < c; i ++) {
    var worker = cluster.workers[current[i]]
    debug('resizing down', current[i])
    worker.once('exit', then())
    if (worker && worker.process.connected) {
      disconnectWorker(worker)
    }
  }
}



function quitHard () {
  quitting = true
  quit()
}



function quit () {
  clearTimeout(resize_timeout_in_danger)
  if (quitting) {
    debug("Forceful shutdown")
    // last ditch effort to force-kill all workers.
    Object.keys(cluster.workers).forEach(function (id) {
      var w = cluster.workers[id]
      if (w && w.process) w.process.kill("SIGKILL")
    })
    process.exit(1)
  }

  debug("Graceful shutdown...")
  clusterSize = 0
  quitting = true
  restart(function () {
    debug("Graceful shutdown successful")
    setTimeout(function() {
      process.exit(0)
    }, 20)
  })
}


function setupSignals () {
  try {
    process.on("SIGHUP", restart)
    process.on("SIGINT", quit)
  } catch (e) {
    // Must be on Windows, waaa-waaah.
  }

  process.on("exit", function () {
    if (!quitting) quitHard()
  })
}
