/*
This file is part of "love.js" by 2dengine.
https://2dengine.com/doc/lovejs.html

MIT License

Copyright (c) 2022 2dengine LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(function() {
  var Player = {};
  var spinner = null;
  var lastMainLoopTickAt = Date.now();
  var watchdogInstalled = false;

  Player.loadStatus = function(status) {
    if (spinner) {
      spinner.dataset.status = status;
    }
  };

  // 진행률을 로딩 카드에 올린다. 30MB 를 받는 30초 동안 화면에 아무 변화가
  // 없으면 사용자는 멈춘 것으로 보고 앱을 끈다.
  var loadingCard = null;
  var loadingMessage = null;
  var loadingFill = null;

  Player.showLoadingCard = function() {
    if (loadingCard === null) {
      loadingCard = document.getElementById('loading-card');
      loadingMessage = document.getElementById('loading-message');
      loadingFill = document.getElementById('loading-fill');
    }
    if (loadingCard)
      loadingCard.classList.add('visible');
  };

  Player.hideLoadingCard = function() {
    if (loadingCard)
      loadingCard.classList.remove('visible');
  };

  Player.loadProgress = function(received, total) {
    Player.showLoadingCard();
    if (!loadingFill || !loadingMessage)
      return;

    var mb = function (bytes) {
      return (bytes / 1048576).toFixed(1);
    };

    if (total > 0) {
      var percent = Math.min(100, Math.floor(received / total * 100));
      loadingFill.classList.remove('indeterminate');
      loadingFill.style.width = percent + '%';
      loadingMessage.textContent = '게임을 불러오는 중... ' + percent + '%';
    } else {
      // 총량을 모르면 비율을 지어내지 않는다. 받은 양만 알린다.
      loadingFill.classList.add('indeterminate');
      loadingMessage.textContent = '게임을 불러오는 중... ' + mb(received) + 'MB';
    }
  };

  var indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
  Player.openDB = function () {
    return new Promise(function (resolve, reject) {
      if (!indexedDB)
        reject('IndexedDB is not supported');
      // Open the local database used to cache packages
      var req = indexedDB.open('EM_PRELOAD_CACHE', 1);
      req.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (db.objectStoreNames.contains('PACKAGES'))
          db.deleteObjectStore('PACKAGES');
        db.createObjectStore('PACKAGES');
      };
      req.onerror = function (error) {
        reject(error);
      };
      req.onsuccess = function (event) {
        // Check if the database is malformed
        var db = event.target.result;
        if (!db.objectStoreNames.contains('PACKAGES')) {
          db.close();
          var req2 = indexedDB.deleteDatabase('EM_PRELOAD_CACHE');
          req2.onerror = function (error) {
            reject(error);
          }
          req2.onsuccess = function (event) {
            resolve(db);
          }
        } else {
          resolve(db);
        }
      };
    });
  }

  Player.deletePkg = function (uri) {
    // Delete the store package from cache
    return new Promise(function (resolve, reject) {
      Player.openDB()
        .then(function (db) {
          var trans = db.transaction(['PACKAGES'], 'readwrite');
          var req = trans.objectStore('PACKAGES').delete(uri);
          req.onerror = function (error) {
            reject(error);
          };
          req.onsuccess = function (event) {
            resolve();
          };
        })
        .catch(function (e) {
          reject(e);
        });
    });
  }

  Player.deletePkgs = function () {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.deleteDatabase('PACKAGES');
      req.onerror = function (e) {
        reject(e);
      };
      req.onsuccess = function (e) {
        resolve();
      };
    });
  }

  Player.storePkg = function(uri, data) {
    return new Promise(function (resolve, reject) {
      Player.openDB()
        .then(function (db) {
          var trans = db.transaction(['PACKAGES'], 'readwrite');
          var req = trans.objectStore('PACKAGES').put(data, uri);
          req.onerror = function (error) {
            reject(error);
          };
          req.onsuccess = function (event) {
            resolve();
          };
        })
        .catch(function (e) {
          reject(e);
        });
    });
  }

  Player.readPkg = function (uri) {
    return new Promise(function (resolve, reject) {
      Player.openDB()
        .then(function (db) {
          // Check if there's a cached package, and if so whether it's the latest available
          var trans = db.transaction(['PACKAGES'], 'readonly');
          var req = trans.objectStore('PACKAGES').get(uri);
          req.onerror = function (error) {
            reject(error);
          };
          req.onsuccess = function (event) {
            resolve(event.target.result);
          };
        })
        .catch(function (e) {
          reject(e);
        });
    });
  }

  // 응답 본문을 흘려 읽으면서 진행률을 보고한다. Content-Length 가 없으면
  // 비율을 알 수 없으므로 받은 바이트만 알린다 -- 그래도 "멈춤" 과
  // "받는 중" 은 구분된다.
  Player.readWithProgress = function(res) {
    var total = Number(res.headers.get('Content-Length')) || 0;
    var reader = res.body.getReader();
    var chunks = [];
    var received = 0;

    Player.loadProgress(0, total);

    return new Promise(function (resolve, reject) {
      var pump = function () {
        reader.read()
          .then(function (step) {
            if (step.done) {
              var merged = new Uint8Array(received);
              var offset = 0;
              for (var i = 0; i < chunks.length; i++) {
                merged.set(chunks[i], offset);
                offset += chunks[i].length;
              }
              Player.loadProgress(received, total || received);
              resolve(merged.buffer);
              return;
            }
            chunks.push(step.value);
            received += step.value.length;
            Player.loadProgress(received, total);
            pump();
          })
          .catch(reject);
      };
      pump();
    });
  };

  Player.fetchPkg = function(uri, nocache, love) {
    return new Promise(function (resolve, reject) {
      var data;
      var fetchRemote = function () {
          if (data && !nocache) {
            resolve(data);
            return;
          }
          // Fetch the package remotely
          Player.loadStatus('fetch:' + uri);
          console.log('fetching:'+uri);
          fetch(uri, {
            cache: nocache ? 'no-store' : 'default'
          })
            .then(function (res) {
              if (!res.ok)
                return reject('Could not fetch the love package');
              // 게임 패키지는 30MB 라 느린 회선에서 30초를 넘긴다. 그동안
              // 화면은 검은 배경에 스피너뿐이라, 받는 중인지 멈춘 것인지
              // 구분할 방법이 사용자에게 없다. body 를 흘려 읽으면서
              // 진행률을 낸다. res.arrayBuffer() 는 다 받을 때까지 아무것도
              // 알려주지 않으므로 쓸 수 없다.
              if (!love || !res.body || !res.body.getReader)
                return res.arrayBuffer();
              return Player.readWithProgress(res);
            })
            .then(function (data) {
              data = new Uint8Array(data);
              if (love) {
                // Check if the header is a valid ZIP archive
                var head = [80,75,3,4];
                for (var i = 0; i < head.length; i++)
                  if (data[i] != head[i])
                    return reject('The fetched resource is not a valid love package');
              }
              // Cache remote package for subsequent requests
              Player.storePkg(uri, data);
              Player.loadStatus('fetched:' + uri);
              resolve(data);
            });
      };

      if (nocache) {
        fetchRemote();
        return;
      }

      Player.loadStatus('read-cache:' + uri);
      Player.readPkg(uri)
        .then (function (cache) {
          data = cache;
        })
        .catch (function(e) {
          console.warn(e);
        })
        .finally(fetchRemote);
    });
  }

  Player.fetchPkgs = function(uri, nocache) {
    return new Promise(function (resolve, reject) {
      var list = [ uri ];
      list.push('lua/normalize1.lua');
      list.push('lua/normalize2.lua');
      var loaded = 0;
      var cache = {};
      for (let i = 0; i < list.length; i++) {
        Player.fetchPkg(list[i], nocache, i == 0)
          .then(function (raw) {
            cache[list[i]] = raw;
            loaded ++;
            if (list.length == loaded)
              resolve(cache);
          })
          .catch (function(e) {
            reject(e);
          });
      }
    });
  }

  Player.script = function(uri, func) {
    var s = document.createElement('script');
    s.type = 'text/javascript';
    s.src = uri;
    s.async = true;
    s.onload = func;
    document.body.appendChild(s);
  }

  var bridgeActions = {
    profiler: ['send', 'poll'],
    qa: ['send', 'poll'],
    textInput: ['present', 'poll', 'hide'],
    net: [
      'available', 'connect', 'close', 'poll', 'send', 'sessionStart', 'sessionPoll',
      'battleAvailable', 'battleConnect', 'battleClose', 'battlePoll', 'battleSend',
      'postNotepad'
    ],
    netTest: ['setAuto', 'status', 'report'],
    frameDiagnostics: ['reset', 'report'],
    storage: ['available', 'getInfo', 'read', 'write', 'remove'],
    invite: ['available', 'start', 'poll', 'cleanup'],
    haptics: ['available', 'play'],
    observability: ['enabled', 'addBreadcrumb', 'captureLuaError', 'captureMessage', 'setContext'],
    analytics: ['track', 'setContext'],
    ad: ['available', 'load', 'isReady', 'show', 'poll'],
    billing: ['available', 'userKey', 'purchase', 'products', 'recover', 'settle', 'poll'],
    promotion: ['available', 'claim', 'poll'],
    system: ['reload', 'openUrl', 'getClipboardText', 'setClipboardText', 'deviceId'],
  };

  var bridgeTargets = {
    profiler: '__powpowProfiler',
    qa: '__powpowQa',
    textInput: '__powpowTextInput',
    net: '__powpowNet',
    netTest: '__powpowNetTestBridge',
    frameDiagnostics: '__powpowFrameDiagnostics',
    storage: '__powpowStorage',
    invite: '__powpowInvite',
    haptics: '__powpowHaptics',
    observability: '__powpowObservability',
    analytics: '__powpowAnalytics',
    ad: '__powpowAd',
    billing: '__powpowBilling',
    promotion: '__powpowPromotion',
  };

  Player.dispatchBridge = function(cmd) {
    var parsed = new URL(cmd);
    var target = parsed.hostname;
    var action = parsed.pathname.replace(/^\/+/, '');
    var allowed = bridgeActions[target];
    if (!allowed || allowed.indexOf(action) === -1)
      return 'ERR|bridge_action';

    var args = parsed.searchParams.getAll('arg');
    if (parsed.searchParams.get('json') === '1') {
      args = args.map(function(value) {
        return JSON.parse(value);
      });
    }

    if (target === 'system') {
      return Player.dispatchSystemBridge(action, args);
    }

    var objectName = bridgeTargets[target];
    var bridge = objectName && window[objectName];
    var fn = bridge && bridge[action];
    if (typeof fn !== 'function')
      return 'ERR|bridge';
    var result = fn.apply(bridge, args);
    return result === undefined || result === null ? '' : result;
  };

  Player.dispatchSystemBridge = function(action, args) {
    if (action === 'reload') {
      window.location.reload();
      return 'OK';
    }

    // 앱인토스 기기 ID(main.ts 가 심는 __powpowSystem.deviceId). 일반 브라우저는 빈 값.
    if (action === 'deviceId') {
      var deviceSystem = window.__powpowSystem;
      if (!deviceSystem || typeof deviceSystem.deviceId !== 'function')
        return '';
      try {
        var deviceId = deviceSystem.deviceId();
        return typeof deviceId === 'string' ? deviceId : '';
      } catch (e) {
        console.warn(e);
        return '';
      }
    }

    if (action === 'openUrl') {
      var url = String(args[0] || '');
      if (!/^https?:\/\//i.test(url))
        return 'ERR|url';
      // Apps in Toss 웹뷰는 window.open 을 막는다. SDK 브리지(main.ts 가 심는
      // __powpowSystem.openUrl)가 있으면 그쪽으로 외부 브라우저를 연다.
      var system = window.__powpowSystem;
      if (system && typeof system.openUrl === 'function') {
        try {
          var res = system.openUrl(url);
          if (res !== 'ERR|surface')
            return res || 'OK';
        } catch (e) {
          console.warn(e);
        }
      }
      // 일반 브라우저 폴백: 게임의 window.open 은 브리지용으로 덮여 있으므로
      // 원본(Module._open)을 쓴다.
      var opener = (window.Module && window.Module._open) || window.open;
      try {
        opener(url, '_blank', 'noopener');
        return 'OK';
      } catch (e) {
        console.warn(e);
        return 'ERR|open';
      }
    }

    var clipboard = navigator.clipboard;
    if (action === 'getClipboardText') {
      if (!clipboard)
        return '';
      if (clipboard.text !== undefined)
        return clipboard.text || '';
      if (!clipboard.__powpowSyncing && clipboard.readText) {
        clipboard.__powpowSyncing = true;
        clipboard.text = clipboard.text || '';
        clipboard.readText()
          .then(function(text) {
            clipboard.text = text || '';
          })
          .catch(function() {})
          .finally(function() {
            clipboard.__powpowSyncing = false;
          });
      }
      return clipboard.text || '';
    }

    if (action === 'setClipboardText') {
      var text = String(args[0] || '');
      var copied = false;

      // ## 콘솔이 정본이다
      //
      // 웹뷰의 클립보드는 **됐는지 알 수가 없다.** execCommand 는 제스처 밖이라
      // 거부되고(love.js 는 탭을 다음 프레임에서 처리한다), writeText 는 답이
      // 나중에 오고, 둘 다 true 를 돌려주고도 실제로는 안 붙는 조합이 있다.
      // 그래서 성공을 판정해서 그때만 찍지 않는다 -- **누를 때마다 무조건**
      // 콘솔에 찍고, 클립보드는 되면 좋은 덤으로 둔다.
      //
      // DevTools 에서 `copy(__powpowLastCopy)` 로 가져가거나, 아래 줄을
      // 우클릭 -> Copy string contents 한다.
      window.__powpowLastCopy = text;
      console.log('===== POWPOW COPY (' + text.length + ' chars) — copy(__powpowLastCopy) =====');
      console.log(text);

      // Android WebViews (notably Samsung Internet/WebView) may expose
      // navigator.clipboard but reject writeText asynchronously.  The old
      // path also called execCommand without selecting any text, so it could
      // report success to Lua while leaving the system clipboard unchanged.
      // Keep the fallback synchronous: this bridge is reached from the user's
      // tap, which is the user-activation window required by execCommand.
      var copyTarget = document.createElement('textarea');
      copyTarget.value = text;
      copyTarget.setAttribute('readonly', '');
      copyTarget.style.position = 'fixed';
      copyTarget.style.left = '-10000px';
      copyTarget.style.top = '0';
      copyTarget.style.width = '1px';
      copyTarget.style.height = '1px';
      copyTarget.style.opacity = '0';
      document.body.appendChild(copyTarget);
      try {
        copyTarget.focus();
        copyTarget.select();
        copyTarget.setSelectionRange(0, copyTarget.value.length);
        copied = document.execCommand('copy') === true;
      } catch (e) {
        console.warn(e);
      } finally {
        if (copyTarget.parentNode)
          copyTarget.parentNode.removeChild(copyTarget);
      }

      // Keep the standards API for browsers where execCommand is unavailable.
      // Its Promise is intentionally not awaited: love.system.setClipboardText
      // is synchronous at the Lua boundary, while the selected-text fallback
      // above already covers the Android user-activation path.
      //
      // **그렇다고 성공으로 세지는 않는다.** 예전에는 writeText 가 동기적으로
      // 안 터지기만 하면 copied 를 세웠는데, Apps in Toss 웹뷰는 그 약속을
      // **나중에** 거절한다 -- 그래서 Lua 에는 'OK' 가 가고 화면에는 "Copied"
      // 가 뜨는데 클립보드는 비어 있었다. 기다릴 수 없으면 성공이라고 말하지
      // 않는다. 실제로 됐는지는 콘솔이 뒤늦게 알려 준다.
      if (clipboard && clipboard.writeText) {
        try {
          clipboard.writeText(text).then(function() {
            console.log('[powpow] clipboard ok (async)');
          }).catch(function(e) {
            console.warn('[powpow] clipboard.writeText rejected', e);
          });
        } catch (e) {
          console.warn(e);
        }
      }
      // 콘솔에는 이미 찍혔으므로 클립보드가 막혀도 실패가 아니다. 다만 둘을
      // 구별해서 돌려줘야 개발 패널이 "붙여넣기 하면 된다" 와 "콘솔에서
      // 가져가라" 중 맞는 쪽을 말할 수 있다.
      console.log('[powpow] clipboard execCommand=' + copied);
      return copied ? 'OK' : 'CONSOLE';
    }

    return 'ERR|bridge_action';
  };

  Player.execute = function(cmd) {
    if (typeof cmd !== 'string')
      return -1;
    var blockedScheme = 'java' + 'script:';
    if (cmd.startsWith(blockedScheme)) {
      window._output = 'ERR|blocked';
      return 1;
    }
    if (!cmd.startsWith('powpowbridge://'))
      return -1;
    try {
      var res = Player.dispatchBridge(cmd);
      window._output = res;
      return 1;
    } catch (e) {
      console.warn(e);
      window._output = 'ERR|' + (e && e.message ? e.message : String(e));
      return 1;
    }
  }

  Player.resumeRuntime = function(reason, focusCanvas) {
    var Module = window.Module;
    if (!Module)
      return;

    try {
      window.focus();
      if (focusCanvas !== false && canvas && canvas.focus)
        canvas.focus();
    } catch (e) {
      console.warn('resume focus failed', reason, e);
    }

    try {
      var SDL2 = Module.SDL2;
      var audioContext = SDL2 && SDL2.audioContext;
      if (audioContext && audioContext.state === 'suspended' && audioContext.resume)
        audioContext.resume();
    } catch (e) {
      console.warn('resume audio failed', reason, e);
    }

    try {
      var mainLoop = Module.Browser && Module.Browser.mainLoop;
      if (mainLoop && mainLoop.func && (!mainLoop.scheduler || Date.now() - lastMainLoopTickAt > 1200)) {
        mainLoop.resume();
        lastMainLoopTickAt = Date.now();
      }
    } catch (e) {
      console.warn('resume main loop failed', reason, e);
    }
  };

  Player.installRuntimeWatchdog = function(Module) {
    if (watchdogInstalled || !Module || !Module.Browser || !Module.Browser.mainLoop)
      return;

    var mainLoop = Module.Browser.mainLoop;
    if (mainLoop.runIter && !mainLoop.runIter.__powpowWrapped) {
      var runIter = mainLoop.runIter;
      mainLoop.runIter = function(func) {
        lastMainLoopTickAt = Date.now();
        return runIter.call(this, func);
      };
      mainLoop.runIter.__powpowWrapped = true;
    }

    watchdogInstalled = true;
    window.setInterval(function() {
      if (document.visibilityState === 'hidden')
        return;
      // 런타임이 살아 있는지만 확인한다. 여기서 캔버스에 포커스를 강제로
      // 주면 AIT Devtools 입력칸을 편집 중인 사용자의 포커스가 매초 풀린다.
      Player.resumeRuntime('watchdog', false);
    }, 1000);
  };

  Player.runPkgs = function(uri, cache, arg, canvas, ops) {
    return new Promise(function (resolve, reject) {
      var Module = window.Module || {};

      var data = cache[uri];
      var memory = (navigator.deviceMemory || 1)*1e+9;
      Module.INITIAL_MEMORY = Math.min(4*data.length + 2e+7, memory);
      Module.canvas = canvas;
      Module.warn = window.onerror;
      Module.args = arg;

      // import packages
      Module.prerun = function() {
        Module.FS.mkdirTree('/usr/local/share/lua/5.1');
        for (var file in cache) {
          var cfile = cache[file];
          if (file == uri) {
            // game
            //var ptr = Module.getMemory(cfile.length);
            //Module.HEAPU8.set(cfile, ptr);
            Module.FS.createDataFile('/', arg[0], cfile, true, true, true);
          } else {
            // modules
            var fn = file.split('/').pop();
            Module.FS.createDataFile('/usr/local/share/lua/5.1', fn, cfile, true, true, true);
          }
        }
      };

      Module.postrun = function() {
        // hide the spinner
        canvas.style.display = 'block';
        canvas.focus();
        spinner.className = '';
        // 게임이 뜬 뒤에도 카드가 남아 캔버스 위에 겹치면 안 된다.
        Player.hideLoadingCard();
        Player.loadStatus('ready');
      }

      if (window.Love === undefined) {
        // this operation initiates local storage
        var loveJs = ops.version + '/love.js';
        if (ops.build) {
          loveJs += '?build=' + encodeURIComponent(ops.build);
        }
        Player.loadStatus('load-lovejs:' + loveJs);
        Player.script(loveJs, function () {
          Player.loadStatus('loaded-lovejs');
          resolve(Module);
        });
      } else {
        //Module.Browser.pauseMainLoop();
        resolve(Module);
      }

      window.Module = Module;

      // capture commands
      if (Module._open)
        return;
      //Module._open = window.open;
      Module._open = window.open.bind(window);
      window.open = function(url) {
        if (Player.execute(url) !== -1)
          return;
        return Module._open(url);
      }

      // the prompt can send UTF-8 strings to Lua synchronously
      window._output = null;
      //window.output = function(s) {
      //  _output = s;
      //}

      window.prompt = function(a) {
        var tmp = window._output;
        window._output = null;
        return tmp; // UTF8ToString(tmp);
      }

    });
  };

  // DOM
  var script = document.currentScript;
  var canvas = document.getElementById('canvas');
  if (!canvas) {
    canvas = document.createElement('CANVAS');
    canvas.id = 'canvas';
    script.parentNode.insertBefore(canvas, script);
  }
  canvas.oncontextmenu = function () {
    event.preventDefault();
  }
  spinner = document.getElementById('spinner');
  if (!spinner) {
    spinner = document.createElement('DIV');
    spinner.id = 'spinner';
    script.parentNode.after(spinner, script);
  }
  spinner.className = 'pending';

  // Parse arguments from the URL address
  var url = new URL(script.src);
  if (!url.searchParams.has('g'))
    url = new URL(window.location.href);

  var search = url.searchParams;
  var ops = {
    version: search.get('v'),
    nocache: search.get('n') == '1',
    build: search.get('b') || '',
  };
  // ignore invalid version arguments
  if (ops.version != '11.5')
    ops.version = '11.5';

  var uri = search.get('g');
  if (uri == null)
    uri = 'nogame.love';
  var arg = search.get('arg');
  if (arg) {
    try {
      arg = JSON.parse(arg);
      if (!Array.isArray(arg))
        arg = [arg];
    } catch (error) {
      arg = null;
      console.log(error);
    }
  }

  // Runs the requested package
  Player.runLove = function () {
    spinner.className = 'loading';
    // 캐시된 패키지를 읽는 동안에도 화면은 비어 있다. 진행률 첫 보고를
    // 기다리지 말고 곧바로 띄운다.
    Player.showLoadingCard();
    Player.loadStatus('fetch-packages');
    Player.fetchPkgs(uri, ops.nocache)
      .then(function (cache) {
        Player.loadStatus('run-packages');
        // prepare arguments
        var pkg = uri.substring(uri.lastIndexOf('/') + 1).split('?')[0].split('#')[0] || 'game.love';
        var varg = [pkg];
        if (arg && Array.isArray(arg))
          for (var i = 0; i < arg.length; i++)
            varg.push(String(arg[i]));

        Player.runPkgs(uri, cache, varg, canvas, ops)
          .then(function (Module) {
            Love(Module);
            window.setTimeout(function() {
              Player.installRuntimeWatchdog(Module);
              Player.resumeRuntime('love-start');
            }, 0);
          });
      })
      .catch(function (err) {
        Player.loadStatus('error:' + err);
        console.log(err);
        if (uri != 'nogame.love') {
          uri = 'nogame.love';
          arg = null;
          Player.runLove();
        }
      })
  }

  Player.runLove();

  // Handling errors
  window.onerror = function (msg) {
    console.error(msg);
    if (spinner.className != '') {
      canvas.style.display = 'none';
      spinner.className = 'error';
      // 실패 화면 위에 "불러오는 중" 이 남아 있으면 거짓말이 된다.
      Player.hideLoadingCard();
    }
  };

  // Focus when running inside an iFrame
  window.onload = window.focus.bind(window);

  function isAitDevtoolsTarget(target) {
    return target && target.nodeType === 1 && target.closest
      && target.closest('.ait-panel-root');
  }

  function isGameCanvasTarget(target) {
    return target === canvas;
  }

  var aitDevtoolsInteraction = false;
  function rememberAitDevtoolsInteraction(event) {
    if (!isAitDevtoolsTarget(event && event.target))
      return;
    aitDevtoolsInteraction = true;
    window.setTimeout(function() {
      aitDevtoolsInteraction = false;
    }, 0);
  }
  window.addEventListener('pointerdown', rememberAitDevtoolsInteraction, true);
  window.addEventListener('touchstart', rememberAitDevtoolsInteraction, true);

  // Handle touch and mouse input
  window.onclick = window.ontouchstart = function (e) {
    if (!isGameCanvasTarget(e && e.target)) {
      return;
    }
    window.focus();
    Player.resumeRuntime('touch', true);
  };

  window.addEventListener('focus', function() {
    if (aitDevtoolsInteraction || isAitDevtoolsTarget(document.activeElement))
      return;
    Player.resumeRuntime('window-focus', false);
  });

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible')
      Player.resumeRuntime('visibility-visible', false);
  });

  // Disable scrolling while using the arrow keys
  var codes = [37, 38, 39, 40, 13];
  window.onkeydown = window.onkeyup = window.onkeypress = function (e) {
    if (isAitDevtoolsTarget(e && e.target)) {
      return;
    }
    if (codes.indexOf(e.keyCode || e.which || 0) > -1)
      e.preventDefault();
  }

  // Fix persistence issues when navigating back and forth
  window.onpageshow = function (event) {
    if (event.persisted) {
      canvas.style.display = 'none';
      Player.runLove();
      // todo: allow re-running
      //Module.run(Module.args);
    } else {
      if (canvas)
        canvas.style.display = 'block';
      Player.resumeRuntime('pageshow', false);
    }
  };

  // Tries to sync the file-system when navigating away
  // This is not reliable, since async operations are not allowed at this point
  window.onbeforeunload = function(event) {
    // todo: love.event.exit when navigating away
    Module.exit(0);
  };
})();
