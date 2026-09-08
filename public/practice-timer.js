/*
 * Shared practice-timer client.
 *
 * The server owns the clock. This file does three things:
 *   1. Polls /api/event/:id/practice-state and keeps a server-clock offset, so
 *      every device shows the same number even after sleeping or reloading.
 *   2. Renders a local 4x/sec tick from those timestamps (no accumulated count).
 *   3. Rings an alarm + shows a banner when a section ends.
 *
 * Used by views/practice-timer.ejs and the timer panel in views/event-detail.ejs.
 */
(function () {
  'use strict';

  var POLL_MS = 2000;
  var TICK_MS = 250;
  var ALARM_MAX_MS = 10000;
  // A section transition older than this was missed while asleep — show it, but
  // don't blast an alarm for something that happened minutes ago.
  var ALARM_FRESH_MS = 20000;

  // -------------------------------------------------------------------------
  // Alarm: Web Audio tones + vibration + on-screen banner.
  //
  // Mobile browsers refuse audio until the page has seen a user gesture, so
  // every device must call unlock() from a tap of its own — the coach's "Start
  // practice" tap does not arm a parent's phone.
  // -------------------------------------------------------------------------
  function Alarm() {
    this.ctx = null;
    this.unlocked = false;
    this.timer = null;
    this.stopAt = 0;
    this.banner = null;
    this.keepAlive = null;
  }

  Alarm.prototype.unlock = function () {
    try {
      if (!this.ctx) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return false;
        this.ctx = new Ctx();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();

      // A silent looping source keeps the audio graph alive so the context is
      // less likely to be torn down when the screen turns off.
      if (!this.keepAlive) {
        var buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
        var src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        var g = this.ctx.createGain();
        g.gain.value = 0.0001;
        src.connect(g);
        g.connect(this.ctx.destination);
        src.start(0);
        this.keepAlive = src;
      }
      this.unlocked = this.ctx.state === 'running';
      return this.unlocked;
    } catch (e) {
      return false;
    }
  };

  Alarm.prototype.isUnlocked = function () {
    return !!(this.ctx && this.ctx.state === 'running');
  };

  // One shaped tone. Ramped gain, so it reads as a chime rather than a click.
  Alarm.prototype.tone = function (freq, at, dur, vol) {
    try {
      var ctx = this.ctx;
      if (!ctx) return;
      var t = ctx.currentTime + at;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(vol || 0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    } catch (e) {}
  };

  Alarm.prototype.blip = function (freq) {
    if (!this.isUnlocked()) return;
    this.tone(freq || 660, 0, 0.12, 0.22);
  };

  Alarm.prototype.burst = function () {
    this.tone(880, 0.0, 0.18);
    this.tone(1180, 0.22, 0.18);
    this.tone(880, 0.44, 0.18);
  };

  Alarm.prototype.ring = function (title, subtitle) {
    var self = this;
    this.showBanner(title, subtitle);
    try {
      if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400]);
    } catch (e) {}

    if (!this.isUnlocked()) {
      // No audio permission on this device — the banner is the whole alarm.
      window.setTimeout(function () { self.hideBanner(); }, ALARM_MAX_MS);
      return;
    }

    this.stopAudio();
    this.burst();
    this.stopAt = Date.now() + ALARM_MAX_MS;
    this.timer = window.setInterval(function () {
      if (Date.now() >= self.stopAt) { self.stop(); return; }
      self.burst();
      try { if (navigator.vibrate) navigator.vibrate([400, 150, 400]); } catch (e) {}
    }, 1200);
  };

  Alarm.prototype.stopAudio = function () {
    if (this.timer) { window.clearInterval(this.timer); this.timer = null; }
  };

  Alarm.prototype.stop = function () {
    this.stopAudio();
    this.hideBanner();
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) {}
  };

  Alarm.prototype.showBanner = function (title, subtitle) {
    var self = this;
    if (!this.banner) {
      var el = document.createElement('div');
      el.id = 'pt-alarm-banner';
      el.setAttribute('role', 'alert');
      el.style.cssText = [
        'position:fixed', 'left:0', 'right:0', 'top:0', 'z-index:9999',
        'background:#dc2626', 'color:#fff', 'padding:16px 18px',
        'font-family:Arial,Helvetica,sans-serif', 'text-align:center',
        'box-shadow:0 4px 18px rgba(0,0,0,0.45)', 'cursor:pointer',
        'display:none'
      ].join(';');
      el.innerHTML =
        '<div style="font-size:20px;font-weight:800;" id="pt-alarm-title"></div>' +
        '<div style="font-size:14px;opacity:0.9;margin-top:3px;" id="pt-alarm-sub"></div>' +
        '<div style="font-size:12px;opacity:0.8;margin-top:8px;">Tap to dismiss</div>';
      el.onclick = function () { self.stop(); };
      document.body.appendChild(el);
      this.banner = el;
    }
    document.getElementById('pt-alarm-title').textContent = title || 'Time!';
    document.getElementById('pt-alarm-sub').textContent = subtitle || '';
    this.banner.style.display = '';
  };

  Alarm.prototype.hideBanner = function () {
    if (this.banner) this.banner.style.display = 'none';
  };

  // -------------------------------------------------------------------------
  // Clock: polls the server, derives remaining time, detects section changes.
  // -------------------------------------------------------------------------
  function PracticeClock(eventId, opts) {
    opts = opts || {};
    this.eventId = eventId;
    this.onUpdate = opts.onUpdate || function () {};
    this.onError = opts.onError || function () {};
    this.alarm = new Alarm();

    this.state = null;
    this.offset = 0;          // server clock minus this device's clock
    this.lastIndex = null;
    this.lastStatus = null;
    this.lastBlipSecond = null;
    this.wakeLock = null;
    this.polling = false;
  }

  PracticeClock.prototype.now = function () {
    return Date.now() + this.offset;
  };

  PracticeClock.prototype.start = function () {
    var self = this;
    this.poll();
    this.pollTimer = window.setInterval(function () { self.poll(); }, POLL_MS);
    this.tickTimer = window.setInterval(function () { self.render(); }, TICK_MS);

    // Coming back from a locked screen: resync immediately rather than waiting
    // out the poll interval, and re-take the wake lock (it is dropped on hide).
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        self.poll();
        self.requestWakeLock();
        if (self.alarm.ctx && self.alarm.ctx.state === 'suspended') self.alarm.ctx.resume();
      }
    });
    window.addEventListener('online', function () { self.poll(); });
    window.addEventListener('focus', function () { self.poll(); });
  };

  PracticeClock.prototype.poll = function () {
    var self = this;
    if (this.polling) return;
    this.polling = true;
    fetch('/api/event/' + this.eventId + '/practice-state', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('state ' + r.status);
        return r.json();
      })
      .then(function (s) { self.polling = false; self.apply(s); })
      .catch(function (e) { self.polling = false; self.onError(e); });
  };

  PracticeClock.prototype.apply = function (s) {
    if (!s || typeof s.server_now !== 'number') return;
    this.offset = s.server_now - Date.now();

    var prevIndex = this.lastIndex;
    var prevStatus = this.lastStatus;
    var live = s.status === 'running' || s.status === 'paused';
    var wasLive = prevStatus === 'running' || prevStatus === 'paused';

    this.state = s;

    // Only ring on a transition this device actually witnessed, and only when
    // the transition is fresh — a phone waking after 10 minutes shouldn't alarm.
    if (wasLive && prevIndex !== null) {
      var fresh = s.section_started_at !== null && (s.server_now - s.section_started_at) < ALARM_FRESH_MS;
      if (s.status === 'ended' && prevStatus !== 'ended') {
        this.alarm.ring('Practice complete', 'Nice work.');
      } else if (live && s.index > prevIndex && fresh) {
        var cur = s.schedule[s.index];
        this.alarm.ring('Rotate!', cur ? 'Next up: ' + cur.name + ' (' + cur.mins + ' min)' : '');
      }
    }

    this.lastIndex = live ? s.index : null;
    this.lastStatus = s.status;
    if (s.status === 'running') this.requestWakeLock();
    this.render();
  };

  // Remaining ms in the current section, derived fresh from server timestamps.
  PracticeClock.prototype.remaining = function () {
    var s = this.state;
    if (!s || s.section_ends_at === null) return 0;
    var ref = s.status === 'paused' ? s.paused_at : this.now();
    return Math.max(0, s.section_ends_at - ref);
  };

  PracticeClock.prototype.elapsedTotal = function () {
    var s = this.state;
    if (!s || !s.practice_started_at) return 0;
    var ref = s.status === 'ended' ? (s.ended_at || this.now())
      : s.status === 'paused' ? s.paused_at : this.now();
    return Math.max(0, ref - s.practice_started_at);
  };

  PracticeClock.prototype.render = function () {
    var s = this.state;
    if (!s) return;

    // Countdown chirps in the final 3 seconds, at most one per second.
    if (s.status === 'running') {
      var secs = Math.ceil(this.remaining() / 1000);
      if (secs <= 3 && secs > 0 && secs !== this.lastBlipSecond) {
        this.lastBlipSecond = secs;
        this.alarm.blip(700);
      } else if (secs > 3) {
        this.lastBlipSecond = null;
      }
    }
    this.onUpdate(s, this);
  };

  // Fire an action and adopt the response straight away, so the coach who
  // tapped sees the change instantly instead of on the next poll.
  PracticeClock.prototype.send = function (action, body) {
    var self = this;
    this.alarm.unlock();
    return fetch('/api/event/' + this.eventId + '/practice/' + action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.error) { self.onError(new Error(s.error)); return s; }
        self.apply(s);
        return s;
      })
      .catch(function (e) { self.onError(e); });
  };

  PracticeClock.prototype.requestWakeLock = function () {
    var self = this;
    try {
      if (!navigator.wakeLock || this.wakeLock) return;
      navigator.wakeLock.request('screen').then(function (lock) {
        self.wakeLock = lock;
        lock.addEventListener('release', function () { self.wakeLock = null; });
      }).catch(function () {});
    } catch (e) {}
  };

  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var m = Math.floor(s / 60);
    var sec = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  window.PracticeClock = PracticeClock;
  window.practiceFmt = fmt;
})();
