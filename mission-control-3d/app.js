/* Mission Control office. Reads the global DATA object from data.js. */

(function () {
  "use strict";

  var RECENT_HOURS = 12;
  var QUIET_HOURS = 48;

  var motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  var narrowQuery = window.matchMedia("(max-width: 1100px)");

  var state = {
    selected: -1,
    loose: null,
    camera: null,
    renderer: null,
    scene: null,
    clock: null,
    pickables: [],
    selectRing: null,
    pinch: 0,
    view: null,
  };

  var pointers = new Map();
  var raycaster = null;
  var pointer = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fieldText(value) {
    if (value == null) return "";
    return String(value).trim();
  }

  function dash(value) {
    var text = fieldText(value);
    return text ? text : "—";
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function wrapAngle(delta) {
    var full = Math.PI * 2;
    while (delta > Math.PI) delta -= full;
    while (delta < -Math.PI) delta += full;
    return delta;
  }

  function loadData() {
    if (typeof DATA !== "undefined" && DATA && typeof DATA === "object") return DATA;
    if (window.DATA && typeof window.DATA === "object") return window.DATA;
    return null;
  }

  function offsetOf(value) {
    var match = String(value || "").match(/([+-]\d{2}:\d{2}|Z)$/i);
    if (!match) return "Z";
    return match[1].toUpperCase() === "Z" ? "Z" : match[1];
  }

  function parseStamp(value, fallbackOffset) {
    var text = fieldText(value);
    if (!text) return null;
    if (/^\d{4}-\d{2}-\d{2}T/.test(text) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      var exact = Date.parse(text);
      return Number.isNaN(exact) ? null : exact;
    }
    var match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) {
      var loose = Date.parse(text);
      return Number.isNaN(loose) ? null : loose;
    }
    var iso = match[1] + "-" + match[2] + "-" + match[3] + "T" + match[4] + ":" + match[5] + ":" + (match[6] || "00") + (fallbackOffset || "Z");
    var parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function presenceOf(bot, generatedAt) {
    if (fieldText(bot && bot.now)) return "working";
    var offset = offsetOf(generatedAt);
    var seen = parseStamp(bot && bot.lastSeen, offset);
    var generated = parseStamp(generatedAt, offset);
    if (seen == null || generated == null) return "unknown";
    var hours = (generated - seen) / 36e5;
    if (hours <= RECENT_HOURS) return "recent";
    if (hours <= QUIET_HOURS) return "quiet";
    return "away";
  }

  function accentHsl(seed) {
    var hash = 2166136261;
    var text = String(seed);
    var i;
    for (i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return { h: 188 + (Math.abs(hash) % 78), s: 78, l: 58 };
  }

  function hslCss(hsl) {
    return "hsl(" + hsl.h + " " + hsl.s + "% " + hsl.l + "%)";
  }

  function motionFor(presence) {
    if (presence === "working") return { type: 1, bob: 1, light: 0.9, edge: 0.95 };
    if (presence === "recent") return { type: 0.28, bob: 0.55, light: 0.42, edge: 0.5 };
    if (presence === "quiet") return { type: 0, bob: 0.35, light: 0.14, edge: 0.28 };
    if (presence === "away") return { type: 0, bob: 0, light: 0, edge: 0.05 };
    return { type: 0, bob: 0, light: 0, edge: 0.08 };
  }

  function related(list, id) {
    if (!id) return [];
    return list.filter(function (item) {
      return item && fieldText(item.bot) === id;
    });
  }

  function buildRoster(data) {
    var bots = data && Array.isArray(data.bots) ? data.bots : [];
    return bots.map(function (bot, index) {
      var record = bot && typeof bot === "object" ? bot : {};
      var id = fieldText(record.id);
      var name = fieldText(record.name);
      var lists = {
        waiting: data && Array.isArray(data.waiting) ? related(data.waiting, id) : null,
        timeline: data && Array.isArray(data.timeline) ? related(data.timeline, id) : null,
        routines: data && Array.isArray(data.routines) ? related(data.routines, id) : null,
        observed: data && Array.isArray(data.observedRoutines) ? related(data.observedRoutines, id) : null,
      };
      return {
        index: index,
        id: id,
        name: name,
        displayName: name || id || "—",
        lastSeen: fieldText(record.lastSeen),
        now: fieldText(record.now),
        presence: presenceOf(record, data && data.generatedAt),
        accent: accentHsl(id || "station-" + index),
        waiting: lists.waiting,
        timeline: lists.timeline,
        routines: lists.routines,
        observed: lists.observed,
        focus: null,
        joints: null,
        mats: null,
        light: null,
        canvas: null,
        ctx: null,
        texture: null,
        motion: motionFor(presenceOf(record, data && data.generatedAt)),
        phase: index * 0.73,
      };
    });
  }

  function indexFor(id, roster) {
    var key = fieldText(id);
    if (!key) return -1;
    var i;
    for (i = 0; i < roster.length; i += 1) {
      if (roster[i].id === key) return i;
    }
    return -1;
  }

  function nameFor(id, roster) {
    var key = fieldText(id);
    if (!key) return "—";
    var index = indexFor(key, roster);
    return index >= 0 ? roster[index].displayName : key;
  }

  function indexForName(name, roster) {
    var key = fieldText(name);
    if (!key) return -1;
    var i;
    for (i = 0; i < roster.length; i += 1) {
      if (roster[i].displayName === key) return i;
    }
    return -1;
  }

  function showBanner(text) {
    var banner = document.getElementById("banner");
    banner.hidden = false;
    banner.textContent = text;
  }

  function header(title, count) {
    var row = el("div", "block-title");
    row.append(el("h2", null, title));
    if (count != null) row.append(el("span", "pill", String(count)));
    return row;
  }

  function makeItem(title, meta, stationIndex, loose, dotColor) {
    var button = el("button", "item");
    button.type = "button";
    var titleRow = el("span", "item-title");
    if (dotColor) {
      var dot = el("i", "dot");
      dot.style.background = dotColor;
      titleRow.append(dot);
    }
    titleRow.append(document.createTextNode(title));
    button.append(titleRow);
    if (meta) button.append(el("span", "item-meta", meta));
    if (stationIndex >= 0) button.dataset.station = String(stationIndex);
    button.addEventListener("click", function () {
      if (stationIndex >= 0) selectIndex(stationIndex, "list");
      else showLoose(loose);
    });
    return button;
  }

  function fillRecords(parent, rows, toItem) {
    if (!rows || !rows.length) {
      parent.append(el("p", "empty", "no data"));
      return;
    }
    rows.forEach(function (row) {
      parent.append(toItem(row));
    });
  }

  function renderStat(data) {
    var stat = document.getElementById("stat");
    stat.replaceChildren();
    var heading = el("h1");
    heading.append(el("span", "eyebrow", "Mission Control"));
    var waiting = data && Array.isArray(data.waiting) ? data.waiting : null;
    var count = el("span", waiting ? "stat-count" : "stat-count is-empty", waiting ? String(waiting.length) : "—");
    heading.append(count);
    heading.append(el("span", "stat-label", "waiting on Eric"));
    stat.append(heading);
    var stamp = data && fieldText(data.generatedAt);
    stat.append(el("span", "asof", "As of " + (stamp || "—")));
    var note = el("details", "note");
    var noteText = data && fieldText(data.windowNote);
    note.append(el("summary", null, noteText ? "Window note" : "Window note: no data"));
    if (noteText) note.append(el("p", null, noteText));
    stat.append(note);
  }

  function renderWaiting(data, roster) {
    var root = document.getElementById("waiting");
    root.replaceChildren();
    var rows = data && Array.isArray(data.waiting) ? data.waiting : null;
    root.append(header("Waiting on Eric", rows ? rows.length : "—"));
    fillRecords(root, rows, function (item) {
      var record = item && typeof item === "object" ? item : {};
      var index = indexFor(record.bot, roster);
      var meta = [nameFor(record.bot, roster), dash(record.at), dash(record.source)].join(" · ");
      return makeItem(dash(record.text), meta, index, { kind: "waiting", record: record }, index >= 0 ? hslCss(roster[index].accent) : "");
    });
  }

  function renderFleet(data, roster) {
    var root = document.getElementById("fleet");
    root.replaceChildren();
    var known = data && Array.isArray(data.bots);
    root.append(header("Fleet", known ? roster.length : "—"));
    if (!known || !roster.length) {
      root.append(el("p", "empty", "no data"));
      return;
    }
    roster.forEach(function (bot) {
      var meta = "Last seen " + dash(bot.lastSeen) + " · Now " + dash(bot.now);
      root.append(makeItem(bot.displayName, meta, bot.index, null, hslCss(bot.accent)));
    });
  }

  function heatModel(data) {
    if (!data || !data.heatmap || typeof data.heatmap !== "object") return null;
    var days = Array.isArray(data.heatmap.days) ? data.heatmap.days : [];
    var values = Array.isArray(data.heatmap.values) ? data.heatmap.values : [];
    if (!days.length && !values.length) return { empty: true, days: days, values: values, cols: 0, rows: 0, max: null };
    var rows = Math.max(days.length, values.length);
    var cols = 0;
    var max = null;
    values.forEach(function (row) {
      if (!Array.isArray(row)) return;
      cols = Math.max(cols, row.length);
      row.forEach(function (value) {
        if (typeof value === "number" && Number.isFinite(value)) {
          max = max == null ? value : Math.max(max, value);
        }
      });
    });
    return { empty: false, days: days, values: values, cols: cols, rows: rows, max: max };
  }

  function heatCss(amount) {
    var red = Math.round(12 + amount * 158);
    var green = Math.round(32 + amount * 196);
    var blue = Math.round(42 + amount * 188);
    return "rgb(" + red + "," + green + "," + blue + ")";
  }

  function renderHeat(heat) {
    var root = document.getElementById("heatmap");
    root.replaceChildren();
    var title = heat && heat.cols && heat.cols !== 24 ? "Activity" : "Activity by hour";
    root.append(header(title));
    if (!heat || heat.empty || !heat.cols || !heat.rows) {
      root.append(el("p", "empty", "no data"));
      return;
    }
    if (heat.cols === 24) root.append(el("p", "heat-caption", "Each row is one day. Columns run hour 0 to 23."));
    else root.append(el("p", "heat-caption", "Each row is one day."));
    var scroll = el("div", "heat-scroll");
    var r;
    for (r = 0; r < heat.rows; r += 1) {
      var row = el("div", "heat-row");
      row.style.gridTemplateColumns = "52px repeat(" + heat.cols + ", 11px)";
      var day = heat.days[r] != null && fieldText(heat.days[r]) ? fieldText(heat.days[r]) : "—";
      row.append(el("span", "day", day));
      var values = Array.isArray(heat.values[r]) ? heat.values[r] : [];
      var c;
      for (c = 0; c < heat.cols; c += 1) {
        var cell = el("span", "cell");
        var value = values[c];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          cell.classList.add("is-empty");
          cell.title = day + " · column " + c + ": no data";
        } else {
          var amount = heat.max > 0 ? value / heat.max : 0;
          cell.style.background = heatCss(amount);
          cell.title = heat.cols === 24 ? day + " hour " + c + ": " + value : day + " column " + c + ": " + value;
        }
        row.append(cell);
      }
      scroll.append(row);
    }
    root.append(scroll);
    root.append(el("p", "peak", heat.max == null ? "peak —" : "peak " + heat.max));
  }

  function renderTimeline(data, roster) {
    var root = document.getElementById("timeline");
    root.replaceChildren();
    var rows = data && Array.isArray(data.timeline) ? data.timeline : null;
    root.append(header("Recent activity", rows ? rows.length : "—"));
    fillRecords(root, rows, function (item) {
      var record = item && typeof item === "object" ? item : {};
      var index = indexFor(record.bot, roster);
      var meta = nameFor(record.bot, roster) + " · " + dash(record.at);
      return makeItem(dash(record.text), meta, index, { kind: "timeline", record: record }, index >= 0 ? hslCss(roster[index].accent) : "");
    });
  }

  function renderRoutines(data, roster) {
    var root = document.getElementById("routines");
    root.replaceChildren();
    root.append(header("Routines"));
    var upcoming = data && Array.isArray(data.routines) ? data.routines : null;
    var observed = data && Array.isArray(data.observedRoutines) ? data.observedRoutines : null;
    var hidden = data && Array.isArray(data.routinesNotVisible) ? data.routinesNotVisible : null;
    root.append(el("h3", "subhead", "Upcoming"));
    fillRecords(root, upcoming, function (item) {
      var record = item && typeof item === "object" ? item : {};
      var index = indexFor(record.bot, roster);
      var meta = [nameFor(record.bot, roster), dash(record.next), dash(record.cron)].join(" · ");
      return makeItem(dash(record.name), meta, index, { kind: "routine", record: record });
    });
    root.append(el("h3", "subhead", "Observed"));
    fillRecords(root, observed, function (item) {
      var record = item && typeof item === "object" ? item : {};
      var index = indexFor(record.bot, roster);
      var meta = nameFor(record.bot, roster) + " · " + dash(record.seen);
      return makeItem(dash(record.name), meta, index, { kind: "observed", record: record });
    });
    root.append(el("h3", "subhead", "Not visible"));
    fillRecords(root, hidden, function (name) {
      var index = indexForName(name, roster);
      return makeItem(dash(name), index >= 0 ? roster[index].displayName : "", index, { kind: "hidden", name: fieldText(name) });
    });
  }

  function addDefinition(list, label, value) {
    list.append(el("dt", null, label));
    list.append(el("dd", null, dash(value)));
  }

  function fillRelated(parent, title, rows, render) {
    parent.append(el("h3", "subhead", title));
    fillRecords(parent, rows, render);
  }

  function detailShell(titleText) {
    var root = document.getElementById("detail");
    root.replaceChildren();
    root.hidden = false;
    document.body.classList.add("has-selection");
    var head = el("div", "detail-head");
    head.append(el("h2", null, titleText));
    var close = el("button", "close", "Close");
    close.type = "button";
    close.addEventListener("click", function () {
      selectIndex(-1, "close");
    });
    head.append(close);
    root.append(head);
    return root;
  }

  function renderDetail(roster) {
    if (state.loose) {
      renderLoose(state.loose, roster);
      return;
    }
    if (state.selected < 0 || !roster[state.selected]) {
      document.getElementById("detail").hidden = true;
      document.body.classList.remove("has-selection");
      return;
    }
    var bot = roster[state.selected];
    var root = detailShell(bot.displayName);
    var list = el("dl", "kv");
    addDefinition(list, "Last seen", bot.lastSeen);
    addDefinition(list, "Now", bot.now);
    addDefinition(list, "Id", bot.id);
    root.append(list);
    fillRelated(root, "Waiting on Eric", bot.waiting, function (item) {
      var record = item && typeof item === "object" ? item : {};
      return makeItem(dash(record.text), [dash(record.at), dash(record.source)].join(" · "), bot.index, null);
    });
    fillRelated(root, "Recent activity", bot.timeline, function (item) {
      var record = item && typeof item === "object" ? item : {};
      return makeItem(dash(record.text), dash(record.at), bot.index, null);
    });
    fillRelated(root, "Upcoming routines", bot.routines, function (item) {
      var record = item && typeof item === "object" ? item : {};
      return makeItem(dash(record.name), [dash(record.next), dash(record.cron)].join(" · "), bot.index, null);
    });
    fillRelated(root, "Observed routines", bot.observed, function (item) {
      var record = item && typeof item === "object" ? item : {};
      return makeItem(dash(record.name), dash(record.seen), bot.index, null);
    });
  }

  function renderLoose(loose, roster) {
    var record = loose.record && typeof loose.record === "object" ? loose.record : {};
    var title = loose.kind === "hidden" ? dash(loose.name) : dash(record.text || record.name);
    var root = detailShell(title);
    var list = el("dl", "kv");
    if (loose.kind === "hidden") {
      addDefinition(list, "Name", loose.name);
    } else {
      addDefinition(list, "Bot", nameFor(record.bot, roster));
      addDefinition(list, "Id", record.bot);
      if ("at" in record) addDefinition(list, "At", record.at);
      if ("next" in record) addDefinition(list, "Next", record.next);
      if ("cron" in record) addDefinition(list, "Cron", record.cron);
      if ("seen" in record) addDefinition(list, "Seen", record.seen);
      if ("source" in record) addDefinition(list, "Source", record.source);
      if ("text" in record) addDefinition(list, "Text", record.text);
      if ("name" in record) addDefinition(list, "Name", record.name);
    }
    root.append(list);
    root.append(el("p", "empty", loose.kind === "hidden" ? "No station matches this name." : "No station matches this bot id."));
  }

  function paintSelection() {
    var current = state.selected;
    document.querySelectorAll("[data-station]").forEach(function (node) {
      var on = current >= 0 && node.dataset.station === String(current);
      node.classList.toggle("is-on", on);
      if (node.tagName === "BUTTON") node.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function setSheet(name) {
    document.body.dataset.sheet = name;
    document.querySelectorAll("#tabs button").forEach(function (button) {
      var on = button.dataset.sheet === name;
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function selectIndex(index, source) {
    if (index == null || index < 0 || index >= roster.length) index = -1;
    state.selected = index;
    state.loose = null;
    paintSelection();
    renderDetail(roster);
    if (index >= 0 && state.view && state.view.targetRadius > state.view.closeR) {
      state.view.targetRadius = state.view.closeR;
    }
    if (narrowQuery.matches && index >= 0 && source !== "close") setSheet("floor");
  }

  function showLoose(loose) {
    state.selected = -1;
    state.loose = loose;
    paintSelection();
    renderDetail(roster);
    if (narrowQuery.matches) setSheet("floor");
  }

  function renderTabs() {
    var nav = document.getElementById("tabs");
    [
      ["floor", "Floor"],
      ["waiting", "Waiting"],
      ["activity", "Activity"],
      ["routines", "Routines"],
      ["fleet", "Fleet"],
    ].forEach(function (pair) {
      var button = el("button", pair[0] === "floor" ? "is-on" : "", pair[1]);
      button.type = "button";
      button.dataset.sheet = pair[0];
      button.setAttribute("aria-pressed", pair[0] === "floor" ? "true" : "false");
      button.addEventListener("click", function () {
        setSheet(pair[0]);
      });
      nav.append(button);
    });
  }

  function chooseCols(count) {
    if (count <= 1) return 1;
    var best = 1;
    var bestScore = Infinity;
    var cols;
    for (cols = 1; cols <= Math.min(8, count); cols += 1) {
      var rows = Math.ceil(count / cols);
      var orphan = count % cols === 1 && count > cols;
      var score = Math.abs(cols - rows * 1.7) + (orphan ? 2 : 0) + rows * 0.15;
      if (score < bestScore) {
        bestScore = score;
        best = cols;
      }
    }
    return best;
  }

  function layoutFor(count) {
    if (count <= 0) return { places: [], cols: 0, rows: 0, width: 12, depth: 9 };
    var cols = chooseCols(count);
    var rows = Math.ceil(count / cols);
    var gapX = cols >= 5 ? 3.25 : 3.6;
    var gapZ = 4.55;
    var places = [];
    var index;
    for (index = 0; index < count; index += 1) {
      var row = Math.floor(index / cols);
      var col = index % cols;
      var rowCount = Math.min(cols, count - row * cols);
      places.push({
        x: (col - (rowCount - 1) / 2) * gapX,
        z: (row - (rows - 1) / 2) * gapZ,
      });
    }
    return {
      places: places,
      cols: cols,
      rows: rows,
      width: Math.max(count < 4 ? 8 : 12, (cols - 1) * gapX + 6.2),
      depth: Math.max(count < 4 ? 7.5 : 10, (rows - 1) * gapZ + 8.4),
    };
  }

  function mesh(geo, material, x, y, z) {
    var item = new THREE.Mesh(geo, material);
    item.position.set(x, y, z);
    return item;
  }

  function mulberry32(seed) {
    var value = seed >>> 0;
    return function rand() {
      value |= 0;
      value = (value + 0x6d2b79f5) | 0;
      var t = Math.imul(value ^ (value >>> 15), 1 | value);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeCanvas(width, height) {
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function canvasTexture(canvas) {
    var texture = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
  }

  function fillRound(ctx, x, y, w, h, radius) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, radius);
    else ctx.rect(x, y, w, h);
    ctx.fill();
  }

  function fitFont(ctx, text, maxWidth, start, min, weight) {
    var size = start;
    while (size > min) {
      ctx.font = weight + " " + size + "px sans-serif";
      if (ctx.measureText(text).width <= maxWidth) return size;
      size -= 2;
    }
    ctx.font = weight + " " + min + "px sans-serif";
    return min;
  }

  function ellipsize(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var sliced = text;
    while (sliced.length > 1 && ctx.measureText(sliced + "…").width > maxWidth) sliced = sliced.slice(0, -1);
    return sliced + "…";
  }

  function wrapLines(ctx, text, maxWidth, maxLines) {
    var words = String(text).split(/\s+/);
    var lines = [];
    var line = "";
    var i;
    for (i = 0; i < words.length; i += 1) {
      var next = line ? line + " " + words[i] : words[i];
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = words[i];
        if (lines.length === maxLines) break;
      } else {
        line = next;
      }
    }
    if (lines.length < maxLines && line) lines.push(line);
    if (!lines.length) lines.push("");
    lines[lines.length - 1] = ellipsize(ctx, lines[lines.length - 1], maxWidth);
    return lines;
  }

  function drawLabel(bot) {
    var canvas = makeCanvas(512, 168);
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(6, 12, 18, 0.88)";
    fillRound(ctx, 8, 16, 496, 136, 28);
    ctx.lineWidth = 4;
    ctx.strokeStyle = hslCss(bot.accent);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f4fbff";
    fitFont(ctx, bot.displayName, 460, 48, 22, "600");
    ctx.fillText(ellipsize(ctx, bot.displayName, 460), 256, 68);
    ctx.fillStyle = "#c5d6e2";
    ctx.font = "28px sans-serif";
    var sub = bot.now || bot.lastSeen || "—";
    ctx.fillText(ellipsize(ctx, sub, 460), 256, 114);
    return canvas;
  }

  function screenColors(bot) {
    if (bot.presence === "quiet") return { bg: "#14110e", bar: "#e2a45a", scan: "rgba(226, 164, 90, 0.08)" };
    if (bot.presence === "away" || bot.presence === "unknown") return { bg: "#0c1014", bar: "#33404c", scan: "rgba(0,0,0,0)" };
    return { bg: "#07161c", bar: hslCss(bot.accent), scan: "rgba(160, 240, 255, 0.08)" };
  }

  function drawScreen(bot, time) {
    var ctx = bot.ctx;
    var w = bot.canvas.width;
    var h = bot.canvas.height;
    var colors = screenColors(bot);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = colors.bar;
    ctx.fillRect(0, 0, w, 10);
    if ((bot.presence === "working" || bot.presence === "recent") && !motionQuery.matches) {
      var y = 18 + ((time * 42 + bot.phase * 30) % (h - 28));
      ctx.fillStyle = colors.scan;
      ctx.fillRect(0, y, w, 12);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#f4fbff";
    fitFont(ctx, bot.displayName, w - 36, 34, 18, "600");
    ctx.fillText(ellipsize(ctx, bot.displayName, w - 36), 18, 22);
    ctx.font = "22px sans-serif";
    ctx.fillStyle = "#d5e4ee";
    var nowLines = wrapLines(ctx, "Now  " + dash(bot.now), w - 36, 2);
    nowLines.forEach(function (line, index) {
      ctx.fillText(line, 18, 78 + index * 28);
    });
    ctx.fillStyle = "#9fb4c4";
    ctx.fillText(ellipsize(ctx, "Seen  " + dash(bot.lastSeen), w - 36), 18, h - 36);
    if (bot.texture) bot.texture.needsUpdate = true;
  }

  function drawWall(data, heat) {
    var canvas = makeCanvas(1400, 520);
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#071018";
    ctx.fillRect(0, 0, 1400, 520);
    ctx.fillStyle = "#7ee7ff";
    ctx.fillRect(36, 28, 1328, 4);
    ctx.font = "600 24px sans-serif";
    ctx.fillStyle = "#9aefff";
    ctx.fillText("MISSION CONTROL", 44, 78);
    var waiting = data && Array.isArray(data.waiting) ? String(data.waiting.length) : "—";
    ctx.fillStyle = waiting === "—" ? "#93a7b6" : "#ffd89a";
    ctx.font = "700 92px sans-serif";
    ctx.fillText(waiting, 44, 186);
    ctx.fillStyle = "#e7f2f8";
    ctx.font = "600 22px sans-serif";
    ctx.fillText("WAITING ON ERIC", 44, 224);
    ctx.fillStyle = "#93a7b6";
    ctx.font = "18px sans-serif";
    wrapLines(ctx, "As of " + (data && fieldText(data.generatedAt) ? fieldText(data.generatedAt) : "—"), 360, 2).forEach(function (line, index) {
      ctx.fillText(line, 44, 258 + index * 24);
    });
    var left = 470;
    ctx.fillStyle = "#9aefff";
    ctx.font = "600 28px sans-serif";
    ctx.fillText(heat && heat.cols === 24 ? "ACTIVITY BY HOUR" : "ACTIVITY", left, 78);
    if (!heat || heat.empty || !heat.cols || !heat.rows) {
      ctx.fillStyle = "#93a7b6";
      ctx.font = "28px sans-serif";
      ctx.fillText("no data", left, 140);
      return canvas;
    }
    var gridTop = 100;
    var gridH = 340;
    var labelW = 100;
    var gridW = 860;
    var cellW = (gridW - labelW) / heat.cols;
    var cellH = gridH / heat.rows;
    var r;
    for (r = 0; r < heat.rows; r += 1) {
      var day = heat.days[r] != null && fieldText(heat.days[r]) ? fieldText(heat.days[r]) : "—";
      ctx.fillStyle = "#9eb2c2";
      ctx.font = "22px sans-serif";
      ctx.fillText(day, left, gridTop + r * cellH + cellH * 0.72);
      var values = Array.isArray(heat.values[r]) ? heat.values[r] : [];
      var c;
      for (c = 0; c < heat.cols; c += 1) {
        var value = values[c];
        var x = left + labelW + c * cellW;
        var y = gridTop + r * cellH;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          ctx.strokeStyle = "rgba(150,180,200,0.35)";
          ctx.strokeRect(x + 1, y + 2, Math.max(cellW - 3, 1), Math.max(cellH - 4, 1));
        } else {
          ctx.fillStyle = heatCss(heat.max > 0 ? value / heat.max : 0);
          ctx.fillRect(x + 1, y + 2, Math.max(cellW - 3, 1), Math.max(cellH - 4, 1));
        }
      }
    }
    ctx.fillStyle = "#9eb2c2";
    ctx.font = "22px sans-serif";
    ctx.fillText(heat.max == null ? "peak —" : "peak " + heat.max, left, gridTop + gridH + 36);
    return canvas;
  }

  function presenceColor(bot) {
    var color = new THREE.Color();
    if (bot.presence === "quiet") color.set("#e2a45a");
    else if (bot.presence === "away") color.set("#2c3844");
    else if (bot.presence === "unknown") color.set("#44525f");
    else color.setHSL(bot.accent.h / 360, bot.accent.s / 100, bot.accent.l / 100);
    return color;
  }

  function accentColor(bot) {
    var color = new THREE.Color();
    color.setHSL(bot.accent.h / 360, bot.accent.s / 100, bot.accent.l / 100);
    return color;
  }

  function buildShared() {
    return {
      geo: {
        hip: new THREE.SphereGeometry(0.15, 16, 12),
        torso: new THREE.CapsuleGeometry(0.16, 0.28, 4, 10),
        head: new THREE.SphereGeometry(0.135, 20, 16),
        upper: new THREE.CapsuleGeometry(0.046, 0.2, 3, 8),
        fore: new THREE.CapsuleGeometry(0.04, 0.18, 3, 8),
        hand: new THREE.SphereGeometry(0.05, 10, 8),
        visor: new THREE.BoxGeometry(0.18, 0.045, 0.03),
        spine: new THREE.BoxGeometry(0.04, 0.32, 0.03),
        deskTop: new THREE.BoxGeometry(1.48, 0.055, 0.74),
        leg: new THREE.BoxGeometry(0.06, 0.7, 0.06),
        edge: new THREE.BoxGeometry(1.48, 0.016, 0.025),
        keys: new THREE.BoxGeometry(0.48, 0.028, 0.16),
        bezel: new THREE.BoxGeometry(0.82, 0.5, 0.04),
        screen: new THREE.PlaneGeometry(0.74, 0.42),
        pole: new THREE.CylinderGeometry(0.025, 0.03, 0.42, 8),
        bulb: new THREE.SphereGeometry(0.045, 12, 10),
        chairSeat: new THREE.BoxGeometry(0.44, 0.07, 0.44),
        chairBack: new THREE.BoxGeometry(0.44, 0.5, 0.06),
        chairPost: new THREE.CylinderGeometry(0.04, 0.045, 0.38, 8),
        chairBase: new THREE.CylinderGeometry(0.2, 0.24, 0.05, 12),
        hit: new THREE.BoxGeometry(1.6, 1.9, 1.85),
        shadow: new THREE.PlaneGeometry(1.9, 1.45),
        ring: new THREE.RingGeometry(0.66, 0.75, 32),
      },
      suit: new THREE.MeshStandardMaterial({ color: 0x2a3340, metalness: 0.5, roughness: 0.4 }),
      helm: new THREE.MeshStandardMaterial({ color: 0x1b222b, metalness: 0.64, roughness: 0.28 }),
      glove: new THREE.MeshStandardMaterial({ color: 0x3a4452, metalness: 0.3, roughness: 0.55 }),
      desk: new THREE.MeshStandardMaterial({ color: 0x1a222c, metalness: 0.22, roughness: 0.62 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x8d98a3, metalness: 0.72, roughness: 0.32 }),
      bezel: new THREE.MeshStandardMaterial({ color: 0x0e141b, metalness: 0.4, roughness: 0.46 }),
      keys: new THREE.MeshStandardMaterial({ color: 0x10161c, metalness: 0.18, roughness: 0.72 }),
      hit: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    };
  }

  function addGrid(parent, width, depth) {
    var step = 1;
    var points = [];
    var y = 0.02;
    var x;
    var z;
    for (x = -width / 2; x <= width / 2 + 0.001; x += step) {
      points.push(x, y, -depth / 2, x, y, depth / 2);
    }
    for (z = -depth / 2; z <= depth / 2 + 0.001; z += step) {
      points.push(-width / 2, y, z, width / 2, y, z);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    parent.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x1e6f82, transparent: true, opacity: 0.38 })));
  }

  function addCity(scene, width, depth) {
    var rand = mulberry32(0x5eed);
    var count = 36;
    var geo = new THREE.BoxGeometry(1, 1, 1);
    var mat = new THREE.MeshStandardMaterial({ color: 0x141b24, roughness: 0.96, metalness: 0.04 });
    var buildings = new THREE.InstancedMesh(geo, mat, count);
    var wins = [];
    var i;
    for (i = 0; i < count; i += 1) {
      var edge = i % 4;
      var along = rand() - 0.5;
      var dist = 1.8 + rand() * 5.2;
      var x = 0;
      var z = 0;
      if (edge === 0) { x = -width / 2 - dist; z = along * (depth + 12); }
      if (edge === 1) { x = width / 2 + dist; z = along * (depth + 12); }
      if (edge === 2) { z = -depth / 2 - dist; x = along * (width + 12); }
      if (edge === 3) { z = depth / 2 + dist; x = along * (width + 12); }
      var bw = 0.8 + rand() * 1.6;
      var bd = 0.8 + rand() * 1.6;
      var bh = 1.5 + rand() * rand() * 8;
      var dummy = new THREE.Object3D();
      dummy.position.set(x, bh / 2 - 0.2, z);
      dummy.scale.set(bw, bh, bd);
      dummy.updateMatrix();
      buildings.setMatrixAt(i, dummy.matrix);
      var n;
      var windows = 1 + Math.floor(rand() * 3);
      for (n = 0; n < windows; n += 1) {
        var wy = 0.35 + rand() * Math.max(bh - 0.7, 0.2);
        var wx = x;
        var wz = z;
        if (edge === 0) wx += bw / 2 + 0.05;
        if (edge === 1) wx -= bw / 2 + 0.05;
        if (edge === 2) wz += bd / 2 + 0.05;
        if (edge === 3) wz -= bd / 2 + 0.05;
        wins.push({ x: wx, y: wy - 0.2, z: wz, warm: rand() > 0.72 });
      }
    }
    scene.add(buildings);
    if (!wins.length) return;
    var wgeo = new THREE.BoxGeometry(0.14, 0.1, 0.14);
    var wmat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    var dots = new THREE.InstancedMesh(wgeo, wmat, wins.length);
    var cool = new THREE.Color("#7de7ff");
    var warm = new THREE.Color("#ffc28a");
    var dummyWin = new THREE.Object3D();
    wins.forEach(function (win, index) {
      dummyWin.position.set(win.x, win.y, win.z);
      dummyWin.scale.set(1, 1, 1);
      dummyWin.updateMatrix();
      dots.setMatrixAt(index, dummyWin.matrix);
      dots.setColorAt(index, win.warm ? warm : cool);
    });
    scene.add(dots);
  }

  function addShell(scene, shared, layout) {
    var width = layout.width;
    var depth = layout.depth;
    var slab = mesh(new THREE.BoxGeometry(width, 0.18, depth), new THREE.MeshStandardMaterial({ color: 0x121820, metalness: 0.16, roughness: 0.78 }), 0, -0.09, 0);
    scene.add(slab);
    addGrid(scene, width, depth);
    var rim = new THREE.MeshBasicMaterial({ color: 0x3ad7ef });
    scene.add(mesh(new THREE.BoxGeometry(width, 0.025, 0.03), rim, 0, 0.02, depth / 2));
    scene.add(mesh(new THREE.BoxGeometry(width, 0.025, 0.03), rim, 0, 0.02, -depth / 2));
    scene.add(mesh(new THREE.BoxGeometry(0.03, 0.025, depth), rim, width / 2, 0.02, 0));
    scene.add(mesh(new THREE.BoxGeometry(0.03, 0.025, depth), rim, -width / 2, 0.02, 0));
    var glass = new THREE.MeshStandardMaterial({
      color: 0x071018,
      metalness: 0.55,
      roughness: 0.12,
      transparent: true,
      opacity: 0.22,
      emissive: 0x062028,
      emissiveIntensity: 0.35,
    });
    var wallH = 2.5;
    var left = mesh(new THREE.PlaneGeometry(depth, wallH), glass, -width / 2, wallH / 2, 0);
    left.rotation.y = Math.PI / 2;
    var right = mesh(new THREE.PlaneGeometry(depth, wallH), glass, width / 2, wallH / 2, 0);
    right.rotation.y = -Math.PI / 2;
    var front = mesh(new THREE.PlaneGeometry(width, wallH), glass, 0, wallH / 2, depth / 2);
    front.rotation.y = Math.PI;
    scene.add(left, right, front);
    var back = mesh(new THREE.PlaneGeometry(width, wallH), new THREE.MeshStandardMaterial({ color: 0x0d141c, roughness: 0.88 }), 0, wallH / 2, -depth / 2);
    scene.add(back);
    var hw = width / 2 - 0.25;
    var hd = depth / 2 - 0.25;
    [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]].forEach(function (pair) {
      scene.add(mesh(new THREE.BoxGeometry(0.12, 2.9, 0.12), shared.metal, pair[0], 1.45, pair[1]));
      scene.add(mesh(new THREE.BoxGeometry(0.2, 0.045, 0.2), new THREE.MeshBasicMaterial({ color: 0x67e7ff }), pair[0], 2.92, pair[1]));
    });
    var barMat = new THREE.MeshBasicMaterial({ color: 0x8fe7ff });
    var b;
    for (b = 0; b < 3; b += 1) {
      var bar = mesh(new THREE.BoxGeometry(width * 0.62, 0.02, 0.06), barMat, 0, 3.15, -depth * 0.22 + b * depth * 0.22);
      scene.add(bar);
    }
    var ground = mesh(new THREE.CircleGeometry(Math.max(width, depth) * 4, 48), new THREE.MeshBasicMaterial({ color: 0x05070a }), 0, -0.22, 0);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
  }

  function buildFigure(parent, shared, accentMat) {
    var group = new THREE.Group();
    group.position.set(0, 0, 0.38);
    group.scale.setScalar(1.08);
    var hips = mesh(shared.geo.hip, shared.suit, 0, 0.62, 0);
    hips.scale.set(1.15, 0.7, 0.95);
    var torso = mesh(shared.geo.torso, shared.suit, 0, 0.98, 0);
    var head = mesh(shared.geo.head, shared.helm, 0, 1.34, 0.02);
    var visor = mesh(shared.geo.visor, accentMat, 0, 1.35, -0.12);
    var spine = mesh(shared.geo.spine, accentMat, 0, 1.02, 0.18);
    function arm(side) {
      var pivot = new THREE.Group();
      pivot.position.set(side * 0.23, 1.16, 0.02);
      pivot.rotation.z = side * -0.2;
      pivot.rotation.x = 0.72;
      pivot.add(mesh(shared.geo.upper, shared.suit, 0, -0.16, 0));
      var elbow = new THREE.Group();
      elbow.position.set(0, -0.34, 0);
      elbow.rotation.x = 0.95;
      elbow.add(mesh(shared.geo.fore, shared.suit, 0, -0.14, 0));
      elbow.add(mesh(shared.geo.hand, shared.glove, 0, -0.3, 0.02));
      pivot.add(elbow);
      group.add(pivot);
      elbow.userData.baseX = elbow.rotation.x;
      pivot.userData.baseX = pivot.rotation.x;
      return { elbow: elbow, pivot: pivot };
    }
    var left = arm(-1);
    var right = arm(1);
    group.add(hips, torso, head, visor, spine);
    parent.add(group);
    torso.userData.baseY = torso.position.y;
    head.userData.baseX = head.rotation.x;
    return { head: head, torso: torso, left: left, right: right };
  }

  function buildStation(bot, place, shared, shadowTex) {
    var group = new THREE.Group();
    group.position.set(place.x, 0, place.z);
    var lip = presenceColor(bot);
    var accentMat = new THREE.MeshStandardMaterial({
      color: lip,
      emissive: lip,
      emissiveIntensity: bot.motion.edge,
      roughness: 0.32,
      metalness: 0.18,
    });
    var visorMat = new THREE.MeshStandardMaterial({
      color: accentColor(bot),
      emissive: accentColor(bot),
      emissiveIntensity: bot.presence === "away" || bot.presence === "unknown" ? 0.12 : 0.7,
      roughness: 0.3,
      metalness: 0.2,
    });
    var top = mesh(shared.geo.deskTop, shared.desk, 0, 0.74, -0.42);
    group.add(top);
    [[-0.64, -0.68], [0.64, -0.68], [-0.64, -0.16], [0.64, -0.16]].forEach(function (pair) {
      group.add(mesh(shared.geo.leg, shared.metal, pair[0], 0.35, pair[1]));
    });
    group.add(mesh(shared.geo.edge, accentMat, 0, 0.778, -0.05));
    group.add(mesh(shared.geo.keys, shared.keys, 0, 0.786, -0.34));
    var monitor = new THREE.Group();
    monitor.position.set(0, 1.08, -0.7);
    monitor.rotation.x = -0.28;
    bot.canvas = makeCanvas(512, 288);
    bot.ctx = bot.canvas.getContext("2d");
    bot.texture = canvasTexture(bot.canvas);
    drawScreen(bot, 0);
    var screenMat = new THREE.MeshBasicMaterial({ map: bot.texture });
    monitor.add(mesh(shared.geo.bezel, shared.bezel, 0, 0, 0));
    monitor.add(mesh(shared.geo.screen, screenMat, 0, 0, 0.03));
    group.add(monitor);
    group.add(mesh(shared.geo.pole, shared.metal, 0, 0.78, -0.62));
    var bulbMat = new THREE.MeshBasicMaterial({ color: lip });
    group.add(mesh(shared.geo.bulb, bulbMat, 0.62, 0.86, -0.22));
    var chair = new THREE.Group();
    chair.position.set(0, 0, 0.46);
    chair.add(mesh(shared.geo.chairBase, shared.metal, 0, 0.04, 0));
    chair.add(mesh(shared.geo.chairPost, shared.metal, 0, 0.26, 0));
    chair.add(mesh(shared.geo.chairSeat, shared.suit, 0, 0.5, -0.02));
    chair.add(mesh(shared.geo.chairBack, shared.suit, 0, 0.86, 0.18));
    group.add(chair);
    var joints = buildFigure(group, shared, visorMat);
    var labelCanvas = drawLabel(bot);
    var labelTex = canvasTexture(labelCanvas);
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false }));
    var labelW = clamp(1.2 + bot.displayName.length * 0.05, 1.35, 2.2);
    sprite.position.set(0, 1.78, 0.38);
    sprite.scale.set(labelW, labelW * (168 / 512), 1);
    group.add(sprite);
    var shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.85 });
    var shadow = mesh(shared.geo.shadow, shadowMat, 0, 0.025, 0.05);
    shadow.rotation.x = -Math.PI / 2;
    group.add(shadow);
    var ringMat = new THREE.MeshBasicMaterial({ color: lip, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    var ring = mesh(shared.geo.ring, ringMat, 0, 0.03, 0.05);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
    var light = new THREE.PointLight(lip, bot.motion.light * Math.PI * 4, 4.8, 2);
    light.position.set(0, 1.45, -0.15);
    group.add(light);
    var hit = mesh(shared.geo.hit, shared.hit, 0, 0.95, -0.05);
    hit.userData.station = bot.index;
    group.add(hit);
    state.pickables.push(hit);
    bot.joints = joints;
    bot.mats = { edge: accentMat, visor: visorMat };
    bot.light = light;
    bot.focus = new THREE.Vector3(place.x, 1.15, place.z);
    return group;
  }

  function shadowTexture() {
    var canvas = makeCanvas(128, 128);
    var ctx = canvas.getContext("2d");
    var grd = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
    grd.addColorStop(0, "rgba(0,0,0,0.5)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 128);
    return canvasTexture(canvas);
  }

  function buildScene(data, roster, heat) {
    var canvas = document.getElementById("view");
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch (err) {
      console.error(err);
      showBanner("WebGL is not available in this browser. The panels still show the data file.");
      return false;
    }
    if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x07090d);
    state.renderer = renderer;
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07090d);
    state.scene = scene;
    var layout = layoutFor(roster.length);
    var span = Math.max(layout.width, layout.depth);
    scene.fog = new THREE.Fog(0x07090d, span * 0.9, span * 3);
    var camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
    state.camera = camera;
    var home = new THREE.Vector3(0, 0.95, 0);
    state.view = {
      theta: 0.22,
      targetTheta: 0.22,
      phi: 0.84,
      targetPhi: 0.84,
      radius: span * 1.12,
      targetRadius: span * 1.12,
      minR: Math.max(5.5, span * 0.28),
      maxR: span * 3.2,
      closeR: Math.max(7.5, span * 0.42),
      look: home.clone(),
      home: home,
      resumeAt: 0,
    };
    var pi = Math.PI;
    scene.add(new THREE.AmbientLight(0x9aafc2, 0.55 * pi));
    scene.add(new THREE.HemisphereLight(0xd0e7f6, 0x0c1218, 0.72 * pi));
    var key = new THREE.DirectionalLight(0xf7fbff, 1.15 * pi);
    key.position.set(7, 14, 9);
    scene.add(key);
    var fill = new THREE.DirectionalLight(0x67c6e4, 0.45 * pi);
    fill.position.set(-8, 6, -4);
    scene.add(fill);
    var shared = buildShared();
    addShell(scene, shared, layout);
    addCity(scene, layout.width, layout.depth);
    var shade = shadowTexture();
    roster.forEach(function (bot, index) {
      scene.add(buildStation(bot, layout.places[index], shared, shade));
    });
    var wallCanvas = drawWall(data, heat);
    var wallTex = canvasTexture(wallCanvas);
    var screenW = Math.min(Math.max(layout.width * 0.62, 6.4), 8.4);
    var screenH = screenW * (520 / 1400);
    var wall = mesh(new THREE.PlaneGeometry(screenW, screenH), new THREE.MeshBasicMaterial({ map: wallTex }), 0, 1.2 + screenH / 2, -layout.depth / 2 + 0.12);
    var frame = mesh(
      new THREE.PlaneGeometry(screenW + 0.16, screenH + 0.16),
      new THREE.MeshStandardMaterial({ color: 0x101820, metalness: 0.35, roughness: 0.55 }),
      0,
      wall.position.y,
      wall.position.z - 0.03
    );
    scene.add(frame, wall);
    var selectRing = mesh(
      new THREE.RingGeometry(0.82, 0.96, 40),
      new THREE.MeshBasicMaterial({ color: 0x9af6ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
      0,
      0.04,
      0
    );
    selectRing.rotation.x = -Math.PI / 2;
    selectRing.visible = false;
    scene.add(selectRing);
    state.selectRing = selectRing;
    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    state.clock = new THREE.Clock();
    resize();
    window.addEventListener("resize", resize);
    return true;
  }

  function resize() {
    if (!state.renderer || !state.camera) return;
    var width = window.innerWidth;
    var height = Math.max(window.innerHeight, 1);
    var ratio = Math.min(window.devicePixelRatio || 1, width < 800 ? 1.5 : 1.75);
    state.renderer.setPixelRatio(ratio);
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
  }

  function pauseAuto() {
    if (state.view) state.view.resumeAt = performance.now() + 8000;
  }

  function updateCamera(dt) {
    var view = state.view;
    if (!motionQuery.matches && state.selected < 0 && performance.now() > view.resumeAt) {
      view.targetTheta += dt * 0.05;
    }
    var glide = 1 - Math.exp(-dt * 5.5);
    view.theta += wrapAngle(view.targetTheta - view.theta) * glide;
    view.phi += (view.targetPhi - view.phi) * glide;
    view.radius += (view.targetRadius - view.radius) * glide;
    var desired = state.selected >= 0 && roster[state.selected].focus ? roster[state.selected].focus : view.home;
    view.look.lerp(desired, 1 - Math.exp(-dt * 2.6));
    var sinP = Math.sin(view.phi);
    state.camera.position.set(
      view.look.x + view.radius * sinP * Math.sin(view.theta),
      view.look.y + view.radius * Math.cos(view.phi),
      view.look.z + view.radius * sinP * Math.cos(view.theta)
    );
    state.camera.lookAt(view.look);
  }

  function poseStation(bot, time) {
    var scale = motionQuery.matches ? 0 : 1;
    var joints = bot.joints;
    if (!joints) return;
    var typeAmp = bot.motion.type * scale;
    var bobAmp = bot.motion.bob * scale;
    var leftWave = Math.sin(time * 9.2 + bot.phase);
    var rightWave = Math.sin(time * 9.2 + bot.phase + 1.7);
    joints.left.elbow.rotation.x = joints.left.elbow.userData.baseX + leftWave * 0.46 * typeAmp;
    joints.right.elbow.rotation.x = joints.right.elbow.userData.baseX + rightWave * 0.46 * typeAmp;
    joints.left.pivot.rotation.x = joints.left.pivot.userData.baseX + leftWave * 0.06 * typeAmp;
    joints.right.pivot.rotation.x = joints.right.pivot.userData.baseX + rightWave * 0.06 * typeAmp;
    joints.head.rotation.y = Math.sin(time * 0.8 + bot.phase) * 0.16 * Math.max(bobAmp, typeAmp);
    joints.head.rotation.x = joints.head.userData.baseX + Math.sin(time * 1.5 + bot.phase) * 0.05 * bobAmp;
    joints.torso.position.y = joints.torso.userData.baseY + Math.sin(time * 1.35 + bot.phase) * 0.012 * bobAmp;
    var edge = bot.motion.edge;
    if (bot.index === state.selected) edge = Math.max(edge, 0.85);
    bot.mats.edge.emissiveIntensity = edge;
    var visorBase = bot.presence === "working" ? 0.75 + Math.sin(time * 6 + bot.phase) * 0.18 * scale : bot.motion.edge > 0.2 ? 0.45 : 0.12;
    bot.mats.visor.emissiveIntensity = visorBase;
    bot.light.intensity = bot.motion.light * Math.PI * 4 * (bot.presence === "working" ? 0.85 + Math.sin(time * 7 + bot.phase) * 0.15 * scale : 1);
    if (typeAmp > 0) {
      var tick = Math.floor(time * 8);
      if (tick !== bot.screenTick) {
        bot.screenTick = tick;
        drawScreen(bot, time);
      }
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!state.renderer || document.hidden) return;
    var dt = Math.min(state.clock.getDelta(), 0.05);
    var time = state.clock.elapsedTime;
    updateCamera(dt);
    roster.forEach(function (bot) {
      poseStation(bot, time);
    });
    if (state.selectRing) {
      if (state.selected >= 0 && roster[state.selected].focus) {
        state.selectRing.visible = true;
        state.selectRing.position.set(roster[state.selected].focus.x, 0.045, roster[state.selected].focus.z);
        state.selectRing.material.opacity = motionQuery.matches ? 0.9 : 0.62 + Math.sin(time * 3) * 0.28;
      } else {
        state.selectRing.visible = false;
      }
    }
    state.renderer.render(state.scene, state.camera);
    if (!state.ready) {
      state.ready = true;
      document.body.dataset.ready = "1";
      window.missionControl.ready = true;
    }
  }

  function pick(clientX, clientY) {
    if (!state.camera || !raycaster) return -1;
    var rect = state.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, state.camera);
    var hits = raycaster.intersectObjects(state.pickables, false);
    if (!hits.length) return -1;
    return hits[0].object.userData.station;
  }

  function hideHover() {
    document.getElementById("hover").hidden = true;
    var canvas = document.getElementById("view");
    canvas.style.cursor = "grab";
  }

  function updateHover(x, y) {
    var index = pick(x, y);
    var tip = document.getElementById("hover");
    var canvas = document.getElementById("view");
    if (index < 0 || !roster[index]) {
      tip.hidden = true;
      canvas.style.cursor = "grab";
      return;
    }
    canvas.style.cursor = "pointer";
    var bot = roster[index];
    tip.hidden = false;
    tip.replaceChildren(
      el("strong", null, bot.displayName),
      el("span", null, "Now " + dash(bot.now)),
      el("span", null, "Last seen " + dash(bot.lastSeen))
    );
    var width = tip.offsetWidth || 220;
    var height = tip.offsetHeight || 72;
    var left = x + 16;
    var top = y + 16;
    if (left + width > window.innerWidth - 8) left = x - width - 16;
    if (top + height > window.innerHeight - 8) top = y - height - 16;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = Math.max(8, top) + "px";
  }

  function fingerSpan() {
    var pts = Array.from(pointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  function bindInput() {
    var canvas = document.getElementById("view");
    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", function (event) {
      if (!state.camera) return;
      if (event.pointerType === "touch") event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: 0 });
      hideHover();
    });
    canvas.addEventListener("pointermove", function (event) {
      if (!state.camera) return;
      var rec = pointers.get(event.pointerId);
      if (!rec) {
        if (event.pointerType !== "touch") updateHover(event.clientX, event.clientY);
        return;
      }
      var dx = event.clientX - rec.x;
      var dy = event.clientY - rec.y;
      rec.x = event.clientX;
      rec.y = event.clientY;
      rec.moved += Math.abs(dx) + Math.abs(dy);
      if (pointers.size >= 2) {
        var dist = fingerSpan();
        if (state.pinch > 0 && dist > 0) {
          state.view.targetRadius = clamp(state.view.targetRadius * (state.pinch / dist), state.view.minR, state.view.maxR);
        }
        state.pinch = dist;
        pauseAuto();
        return;
      }
      if (rec.moved > 3) {
        state.view.targetTheta -= dx * 0.0052;
        state.view.targetPhi = clamp(state.view.targetPhi - dy * 0.0036, 0.34, 1.22);
        pauseAuto();
      }
    });
    function endPointer(event) {
      var rec = pointers.get(event.pointerId);
      pointers.delete(event.pointerId);
      state.pinch = 0;
      if (!rec || !state.camera) return;
      if (rec.moved < 6 && pointers.size === 0) {
        var index = pick(event.clientX, event.clientY);
        if (index < 0 || index === state.selected) selectIndex(-1, "scene");
        else selectIndex(index, "scene");
      }
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("pointerleave", hideHover);
    canvas.addEventListener("wheel", function (event) {
      if (!state.view) return;
      event.preventDefault();
      state.view.targetRadius = clamp(state.view.targetRadius * Math.exp(event.deltaY * 0.0011), state.view.minR, state.view.maxR);
      pauseAuto();
    }, { passive: false });
    window.addEventListener("keydown", function (event) {
      var tag = document.activeElement && document.activeElement.tagName;
      if (event.key === "Escape") {
        selectIndex(-1, "close");
        if (narrowQuery.matches) setSheet("floor");
        return;
      }
      if (!state.view || tag === "BUTTON" || tag === "SUMMARY" || tag === "INPUT" || tag === "TEXTAREA") return;
      var step = 0.08;
      if (event.key === "ArrowLeft") state.view.targetTheta -= step;
      else if (event.key === "ArrowRight") state.view.targetTheta += step;
      else if (event.key === "ArrowUp") state.view.targetPhi = clamp(state.view.targetPhi - step, 0.34, 1.22);
      else if (event.key === "ArrowDown") state.view.targetPhi = clamp(state.view.targetPhi + step, 0.34, 1.22);
      else if (event.key === "+" || event.key === "=") state.view.targetRadius = clamp(state.view.targetRadius * 0.92, state.view.minR, state.view.maxR);
      else if (event.key === "-" || event.key === "_") state.view.targetRadius = clamp(state.view.targetRadius * 1.08, state.view.minR, state.view.maxR);
      else return;
      pauseAuto();
      event.preventDefault();
    });
    canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault();
      showBanner("WebGL stopped. Reload the page to draw the office again. The panels still show the data file.");
    });
  }

  var data = loadData();
  var roster = buildRoster(data);
  var heat = heatModel(data);

  renderStat(data);
  renderWaiting(data, roster);
  renderFleet(data, roster);
  renderHeat(heat);
  renderTimeline(data, roster);
  renderRoutines(data, roster);
  renderTabs();
  document.getElementById("hint").textContent = "Drag to orbit. Scroll or pinch to zoom. Click a station. Typing follows a now-line. The lamp tracks last seen against the generated time: bright within 12 hours, dim within 48, dark after that.";

  window.missionControl = {
    roster: roster,
    ready: false,
    stationCount: function () { return roster.length; },
    selectedIndex: function () { return state.selected; },
    select: function (index) { selectIndex(index, "api"); },
  };

  if (typeof THREE === "undefined") {
    showBanner("The 3D library did not load. The panels still show the data file.");
    document.body.dataset.ready = "1";
    window.missionControl.ready = true;
  } else if (buildScene(data, roster, heat)) {
    bindInput();
    frame();
  } else {
    document.body.dataset.ready = "1";
    window.missionControl.ready = true;
  }
})();
