/* Mission Control office. loader.js fetches data.json into the global DATA object, then loads this file. */

(function () {
  "use strict";

  // Floor zones. Edit this object to move a bot: matching is case-insensitive
  // against bots[].name. "Reed" also matches a name that starts with "Reed/".
  // The first zone that lists a name wins. Names that match nothing use defaultZone.
  // There is no business field in data.json; this map is the whole assignment.
  // Shelf sits with AKEMI because that is the only list that names Shelf.
  // VILLA VISOUN stays empty until a name is added here.
  var OFFICE = {
    executive: {
      label: "EXECUTIVE OFFICE",
      role: "CoS",
      color: "#ff4f9a",
      names: ["Al Capone"],
    },
    zones: [
      { id: "akemi", label: "AKEMI", color: "#ffb15a", names: ["Kham", "Tally", "Mattie", "Anchor", "Shelf"] },
      { id: "pann", label: "PANN AI", color: "#ff5ec8", names: ["Reed", "Reed/PannaiGrok"] },
      { id: "villa", label: "VILLA VISOUN", color: "#f0d48a", names: [] },
      { id: "personal", label: "PERSONAL", color: "#b388ff", names: ["Sage", "Voss", "Deedkeeper", "Compass"] },
      { id: "fleet", label: "FLEET OPS", color: "#3ee0ff", names: ["Forge", "Proof", "Kit", "X Virality Score", "Rapid Response Desk", "Answering Machina"] },
    ],
    defaultZone: { id: "unassigned", label: "UNASSIGNED", color: "#9eb4c4" },
  };

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
    quality: "high",
    bloom: null,
    bloomFailed: false,
    movers: [],
    timeOffset: 0,
    animTime: 0,
    holdTime: null,
    tourOn: false,
    tourTime: 0,
    dataPacked: "",
    pulling: false,
    officeLayout: null,
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

  function hashText(seed) {
    var hash = 2166136261;
    var text = String(seed);
    var i;
    for (i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash;
  }

  function accentHsl(seed) {
    return { h: 188 + (Math.abs(hashText(seed)) % 78), s: 78, l: 58 };
  }

  function behaviorFor(bot) {
    if (bot.presence === "working") return "type";
    var bucket = (hashText(bot.id || "bot-" + bot.index) >>> 0) % 3;
    if (bucket === 0) return "bob";
    if (bucket === 1) return "look";
    return "walk";
  }

  function glowLevel(presence) {
    if (presence === "working" || presence === "recent") return "bright";
    if (presence === "quiet") return "dim";
    return "dark";
  }

  function glowStrength(level) {
    if (level === "bright") return 1;
    if (level === "dim") return 0.36;
    return 0.08;
  }

  function hslCss(hsl) {
    return "hsl(" + hsl.h + " " + hsl.s + "% " + hsl.l + "%)";
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
      var entry = {
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
        actor: null,
        label: null,
        bubble: null,
        light: null,
        canvas: null,
        ctx: null,
        texture: null,
        yaw: 0,
        phase: index * 0.73,
      };
      entry.behavior = behaviorFor(entry);
      return entry;
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
    var controls = el("div", "controls");
    var quality = el("button", "quality", "Glow: high");
    quality.type = "button";
    quality.id = "quality";
    quality.addEventListener("click", function () {
      applyQuality(state.quality === "low" ? "high" : "low");
    });
    var tour = el("button", "quality tour", "Tour: off");
    tour.type = "button";
    tour.id = "tour";
    tour.setAttribute("aria-pressed", "false");
    tour.title = "Play a slow lap: wide view, the working board, the executive office, then wide again. Off until you turn it on.";
    tour.addEventListener("click", function () {
      setTour(!state.tourOn);
    });
    controls.append(quality, tour);
    stat.append(controls);
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
      var meta = [bot.zoneLabel, "Last seen " + dash(bot.lastSeen), "Now " + dash(bot.now)].filter(Boolean).join(" · ");
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
    addDefinition(list, "Zone", bot.zoneLabel);
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
    root.append(el("p", "empty", loose.kind === "hidden" ? "No bot matches this name." : "No bot matches this id."));
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
    if (count <= 0) return { places: [], cols: 0, rows: 0, gapX: 3.6, gapZ: 4.55, width: 12, depth: 9 };
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
        row: row,
        col: col,
      });
    }
    return {
      places: places,
      cols: cols,
      rows: rows,
      gapX: gapX,
      gapZ: gapZ,
      width: Math.max(count < 4 ? 8 : 12, (cols - 1) * gapX + 6.2),
      depth: Math.max(count < 4 ? 7.5 : 10, (rows - 1) * gapZ + 8.4),
    };
  }

  function configuredMatch(botName, configuredName) {
    var bot = fieldText(botName).toLowerCase();
    var want = fieldText(configuredName).toLowerCase();
    if (!bot || !want) return false;
    if (bot === want) return true;
    return bot.indexOf(want + "/") === 0;
  }

  function zoneForBot(bot) {
    var exec = OFFICE.executive;
    var execNames = exec && Array.isArray(exec.names) ? exec.names : [];
    var i;
    for (i = 0; i < execNames.length; i += 1) {
      if (configuredMatch(bot.name, execNames[i])) {
        return { id: "executive", spec: exec, executive: true, fallback: false };
      }
    }
    var zones = Array.isArray(OFFICE.zones) ? OFFICE.zones : [];
    var z;
    for (z = 0; z < zones.length; z += 1) {
      var list = zones[z] && Array.isArray(zones[z].names) ? zones[z].names : [];
      for (i = 0; i < list.length; i += 1) {
        if (configuredMatch(bot.name, list[i])) {
          return {
            id: fieldText(zones[z].id) || ("zone-" + z),
            spec: zones[z],
            executive: false,
            fallback: false,
          };
        }
      }
    }
    var fallback = OFFICE.defaultZone || { id: "unassigned", label: "UNASSIGNED", color: "#9eb4c4" };
    return {
      id: fieldText(fallback.id) || "unassigned",
      spec: fallback,
      executive: false,
      fallback: true,
    };
  }

  function measureZone(count, executive) {
    if (count <= 0) return { cols: 0, rows: 0, gapX: 3.25, gapZ: 3.9, w: 7.4, d: 4.8 };
    var cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
    var rows = Math.ceil(count / cols);
    var gapX = 3.25;
    var gapZ = 3.9;
    var w = Math.max((cols - 1) * gapX + 4.9, executive ? 8.6 : 6.8);
    var d = Math.max((rows - 1) * gapZ + 5.4, executive ? 7.6 : 5.8);
    return { cols: cols, rows: rows, gapX: gapX, gapZ: gapZ, w: w, d: d };
  }

  function layoutOffice(roster) {
    var groups = [];

    function ensure(id, spec, executive) {
      var i;
      for (i = 0; i < groups.length; i += 1) {
        if (groups[i].id === id) return groups[i];
      }
      var group = {
        id: id,
        label: fieldText(spec && spec.label) || id,
        color: fieldText(spec && spec.color) || "#8aa4b8",
        role: fieldText(spec && spec.role),
        executive: !!executive,
        fallbackOnly: false,
        bots: [],
      };
      groups.push(group);
      return group;
    }

    if (OFFICE.executive) ensure("executive", OFFICE.executive, true);
    var zoneSpecs = Array.isArray(OFFICE.zones) ? OFFICE.zones : [];
    var s;
    for (s = 0; s < zoneSpecs.length; s += 1) {
      if (!zoneSpecs[s]) continue;
      ensure(fieldText(zoneSpecs[s].id) || ("zone-" + s), zoneSpecs[s], false);
    }

    roster.forEach(function (bot) {
      var placed = zoneForBot(bot);
      var group = ensure(placed.id, placed.spec, placed.executive);
      if (placed.fallback) group.fallbackOnly = true;
      group.executive = placed.executive || group.executive;
      if (placed.executive && fieldText(placed.spec && placed.spec.role)) group.role = fieldText(placed.spec.role);
      group.bots.push(bot);
      bot.zoneId = group.id;
      bot.zoneLabel = group.label;
      bot.executive = !!group.executive;
      bot.plateRole = group.executive ? group.role : "";
    });

    groups = groups.filter(function (group) {
      return group.fallbackOnly ? group.bots.length > 0 : true;
    });

    var gap = 1.25;
    var rowGap = 1.45;
    var maxRow = 40;
    var bands = [];
    var band = [];
    var bandW = 0;
    groups.forEach(function (group) {
      var size = measureZone(group.bots.length, group.executive);
      group.cols = size.cols;
      group.rows = size.rows;
      group.gapX = size.gapX;
      group.gapZ = size.gapZ;
      group.w = size.w;
      group.d = size.d;
      if (band.length && bandW + gap + group.w > maxRow) {
        bands.push(band);
        band = [];
        bandW = 0;
      }
      band.push(group);
      bandW += (band.length > 1 ? gap : 0) + group.w;
    });
    if (band.length) bands.push(band);

    var margin = 2.7;
    var totalD = 0;
    var maxW = 0;
    bands.forEach(function (row) {
      var w = 0;
      var d = 0;
      row.forEach(function (group, index) {
        w += group.w + (index ? gap : 0);
        d = Math.max(d, group.d);
      });
      row.bandW = w;
      row.bandD = d;
      maxW = Math.max(maxW, w);
      totalD += d;
    });
    totalD += rowGap * Math.max(0, bands.length - 1);
    var width = Math.max(maxW + margin * 2, 12);
    var depth = Math.max(totalD + margin * 2, 10);
    var places = new Array(roster.length);
    var zCursor = -depth / 2 + margin;
    bands.forEach(function (row) {
      var xCursor = -row.bandW / 2;
      row.forEach(function (group) {
        group.x = xCursor + group.w / 2;
        group.z = zCursor + group.d / 2;
        xCursor += group.w + gap;
        group.bots.forEach(function (bot, index) {
          var col = group.cols ? index % group.cols : 0;
          var rowIndex = group.cols ? Math.floor(index / group.cols) : 0;
          var rowCount = group.cols ? Math.min(group.cols, group.bots.length - rowIndex * group.cols) : 1;
          var localX = (col - (rowCount - 1) / 2) * group.gapX;
          var localZ = group.rows > 1 ? (rowIndex - (group.rows - 1) / 2) * group.gapZ : 0;
          places[bot.index] = { x: group.x + localX, z: group.z + localZ, row: rowIndex, col: col };
        });
      });
      zCursor += row.bandD + rowGap;
    });

    return {
      places: places,
      cols: 0,
      rows: 0,
      gapX: 3.25,
      gapZ: 3.9,
      width: width,
      depth: depth,
      zones: groups,
      zoned: true,
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
    var role = fieldText(bot.plateRole);
    var height = role ? 156 : 118;
    var canvas = makeCanvas(512, height);
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 512, height);
    ctx.fillStyle = "rgba(6, 12, 18, 0.9)";
    fillRound(ctx, 8, 8, 496, height - 16, 22);
    ctx.lineWidth = 5;
    ctx.strokeStyle = hslCss(bot.accent);
    ctx.stroke();
    ctx.fillStyle = hslCss(bot.accent);
    ctx.fillRect(8, 18, 8, height - 36);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f4fbff";
    if (role) {
      fitFont(ctx, bot.displayName, 440, 36, 18, "600");
      ctx.fillText(ellipsize(ctx, bot.displayName, 440), 268, height * 0.38);
      ctx.fillStyle = hslCss(bot.accent);
      fitFont(ctx, role, 440, 22, 14, "600");
      ctx.fillText(ellipsize(ctx, role, 440), 268, height * 0.68);
    } else {
      fitFont(ctx, bot.displayName, 440, 40, 18, "600");
      ctx.fillText(ellipsize(ctx, bot.displayName, 440), 268, height / 2);
    }
    return canvas;
  }

  function drawBubble(bot) {
    var canvas = makeCanvas(768, 300);
    var ctx = canvas.getContext("2d");
    var accent = hslCss(bot.accent);
    ctx.clearRect(0, 0, 768, 300);
    ctx.fillStyle = "rgba(8, 22, 34, 0.82)";
    fillRound(ctx, 16, 16, 736, 268, 36);
    ctx.lineWidth = 8;
    ctx.strokeStyle = accent;
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.16;
    var band;
    for (band = 0; band < 6; band += 1) ctx.fillRect(28, 48 + band * 40, 712, 10);
    ctx.globalAlpha = 1;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = accent;
    ctx.font = "600 28px sans-serif";
    ctx.fillText("NOW", 40, 36);
    ctx.fillStyle = "#f4fbff";
    ctx.font = "600 40px sans-serif";
    wrapLines(ctx, bot.now, 680, 3).forEach(function (line, index) {
      ctx.fillText(line, 40, 92 + index * 52);
    });
    return canvas;
  }

  function screenColors(bot) {
    var accent = hslCss(bot.accent);
    if (bot.presence === "away" || bot.presence === "unknown") {
      return { bg: "#0c1014", bar: "#2c3844", scan: "rgba(0,0,0,0)", text: "#7d8d9a", sub: "#667684" };
    }
    if (bot.presence === "quiet") {
      return { bg: "#101418", bar: accent, scan: "rgba(255,255,255,0.04)", text: "#d5e4ee", sub: "#9eb2c2" };
    }
    return { bg: "#07161c", bar: accent, scan: "rgba(190, 248, 255, 0.16)", text: "#f7fdff", sub: "#d5e8f2" };
  }

  function drawScreen(bot, time) {
    var ctx = bot.ctx;
    var w = bot.canvas.width;
    var h = bot.canvas.height;
    var colors = screenColors(bot);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    if (bot.presence === "working" || bot.presence === "recent") {
      ctx.fillStyle = "rgba(150, 235, 255, 0.14)";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.save();
    if (bot.presence === "quiet") ctx.globalAlpha = 0.5;
    if (bot.presence === "away" || bot.presence === "unknown") ctx.globalAlpha = 0.35;
    ctx.fillStyle = colors.bar;
    ctx.fillRect(0, 0, w, 16);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(0, 16, w, 3);
    ctx.restore();
    if ((bot.presence === "working" || bot.presence === "recent") && !motionQuery.matches) {
      var y = 18 + ((time * 42 + bot.phase * 30) % (h - 28));
      ctx.fillStyle = colors.scan;
      ctx.fillRect(0, y, w, 12);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = colors.text;
    fitFont(ctx, bot.displayName, w - 36, 34, 18, "600");
    ctx.fillText(ellipsize(ctx, bot.displayName, w - 36), 18, 28);
    ctx.font = "22px sans-serif";
    ctx.fillStyle = colors.text;
    var nowLines = wrapLines(ctx, "Now  " + dash(bot.now), w - 36, 2);
    nowLines.forEach(function (line, index) {
      ctx.fillText(line, 18, 78 + index * 28);
    });
    ctx.fillStyle = colors.sub;
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

  function accentColor(bot) {
    var color = new THREE.Color();
    color.setHSL(bot.accent.h / 360, bot.accent.s / 100, bot.accent.l / 100);
    return color;
  }

  function accentStandard(color, intensity) {
    return new THREE.MeshStandardMaterial({
      color: color,
      emissive: color.clone(),
      emissiveIntensity: intensity,
      roughness: 0.3,
      metalness: 0.2,
    });
  }

  function accentBasic(color) {
    return new THREE.MeshBasicMaterial({ color: color.clone() });
  }

  function buildShared() {
    return {
      geo: {
        hip: new THREE.SphereGeometry(0.12, 14, 10),
        torso: new THREE.CapsuleGeometry(0.155, 0.22, 4, 8),
        head: new THREE.SphereGeometry(0.2, 18, 14),
        ear: new THREE.SphereGeometry(0.055, 8, 6),
        visor: new THREE.BoxGeometry(0.28, 0.07, 0.045),
        antenna: new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6),
        bobble: new THREE.SphereGeometry(0.045, 8, 6),
        halo: new THREE.TorusGeometry(0.25, 0.012, 6, 28),
        hover: new THREE.TorusGeometry(0.3, 0.016, 6, 28),
        upper: new THREE.CapsuleGeometry(0.04, 0.16, 3, 6),
        fore: new THREE.CapsuleGeometry(0.034, 0.14, 3, 6),
        hand: new THREE.SphereGeometry(0.046, 8, 6),
        thigh: new THREE.CapsuleGeometry(0.055, 0.2, 3, 6),
        shin: new THREE.CapsuleGeometry(0.044, 0.18, 3, 6),
        foot: new THREE.BoxGeometry(0.1, 0.045, 0.16),
        core: new THREE.SphereGeometry(0.07, 12, 10),
        deskTop: new THREE.BoxGeometry(1.42, 0.06, 0.72),
        pedestal: new THREE.CylinderGeometry(0.16, 0.22, 0.72, 10),
        rim: new THREE.BoxGeometry(1, 0.02, 0.025),
        keys: new THREE.BoxGeometry(0.46, 0.03, 0.16),
        bezel: new THREE.BoxGeometry(0.84, 0.52, 0.045),
        screen: new THREE.PlaneGeometry(0.74, 0.42),
        glowPlane: new THREE.PlaneGeometry(1.08, 0.72),
        chairSeat: new THREE.BoxGeometry(0.42, 0.06, 0.4),
        chairBack: new THREE.BoxGeometry(0.42, 0.46, 0.05),
        chairPost: new THREE.CylinderGeometry(0.035, 0.04, 0.46, 8),
        chairBase: new THREE.CylinderGeometry(0.16, 0.18, 0.04, 10),
        hit: new THREE.BoxGeometry(1.15, 1.55, 0.85),
        deskHit: new THREE.BoxGeometry(1.55, 1.35, 1.15),
        shadow: new THREE.CircleGeometry(0.46, 20),
      },
      suit: new THREE.MeshStandardMaterial({ color: 0x243246, metalness: 0.62, roughness: 0.36 }),
      helm: new THREE.MeshStandardMaterial({ color: 0x141b24, metalness: 0.72, roughness: 0.26 }),
      glove: new THREE.MeshStandardMaterial({ color: 0x3a4554, metalness: 0.32, roughness: 0.5 }),
      desk: new THREE.MeshStandardMaterial({ color: 0x171e28, metalness: 0.48, roughness: 0.38 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x93a3b3, metalness: 0.78, roughness: 0.26 }),
      bezel: new THREE.MeshStandardMaterial({ color: 0x0c1218, metalness: 0.5, roughness: 0.4 }),
      keys: new THREE.MeshStandardMaterial({ color: 0x10161c, metalness: 0.2, roughness: 0.7 }),
      hit: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    };
  }

  function addNeonFloor(parent, layout) {
    var y = 0.028;
    var edge = new THREE.MeshBasicMaterial({ color: 0x49f3ff });
    var w = layout.width - 0.7;
    var d = layout.depth - 0.7;
    parent.add(mesh(new THREE.BoxGeometry(w, 0.02, 0.035), edge, 0, y, d / 2));
    parent.add(mesh(new THREE.BoxGeometry(w, 0.02, 0.035), edge, 0, y, -d / 2));
    parent.add(mesh(new THREE.BoxGeometry(0.035, 0.02, d), edge, w / 2, y, 0));
    parent.add(mesh(new THREE.BoxGeometry(0.035, 0.02, d), edge, -w / 2, y, 0));
    if (layout.zoned) return;
    var aisle = new THREE.MeshBasicMaterial({ color: 0x1ec8ea });
    parent.add(mesh(new THREE.BoxGeometry(0.03, 0.018, d * 0.86), aisle, 0, y, 0));
    var rows = layout.rows || 0;
    var gapZ = layout.gapZ || 4.55;
    var r;
    for (r = 0; r < rows - 1; r += 1) {
      var z = (r + 0.5 - (rows - 1) / 2) * gapZ;
      parent.add(mesh(new THREE.BoxGeometry(w * 0.92, 0.018, 0.04), aisle, 0, y, z));
    }
  }

  function addGlassWall(parent, material, span, height, x, y, z, rotY) {
    var wall = mesh(new THREE.PlaneGeometry(span, height), material, x, y, z);
    wall.rotation.y = rotY;
    parent.add(wall);
  }

  function addShell(scene, shared, layout) {
    var width = layout.width;
    var depth = layout.depth;
    var wallH = 4.7;
    scene.add(mesh(new THREE.BoxGeometry(width, 0.22, depth), new THREE.MeshStandardMaterial({ color: 0x10161e, metalness: 0.42, roughness: 0.48 }), 0, -0.11, 0));
    addNeonFloor(scene, layout);
    var shaftMat = new THREE.MeshStandardMaterial({ color: 0x121820, metalness: 0.55, roughness: 0.4, emissive: 0x0a2030, emissiveIntensity: 0.35 });
    scene.add(mesh(new THREE.BoxGeometry(width * 0.62, 16, depth * 0.62), shaftMat, 0, -8.1, 0));
    var storey;
    var storeyMat = new THREE.MeshBasicMaterial({ color: 0x14586e });
    for (storey = 1; storey <= 4; storey += 1) {
      var sy = -storey * 2.7;
      scene.add(mesh(new THREE.BoxGeometry(width * 0.64, 0.035, 0.05), storeyMat, 0, sy, depth * 0.31));
      scene.add(mesh(new THREE.BoxGeometry(width * 0.64, 0.035, 0.05), storeyMat, 0, sy, -depth * 0.31));
    }
    var glass = new THREE.MeshStandardMaterial({
      color: 0xb7e7ff,
      metalness: 0.15,
      roughness: 0.05,
      transparent: true,
      opacity: 0.07,
      emissive: 0x123044,
      emissiveIntensity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    addGlassWall(scene, glass, depth, wallH, -width / 2, wallH / 2, 0, Math.PI / 2);
    addGlassWall(scene, glass, depth, wallH, width / 2, wallH / 2, 0, -Math.PI / 2);
    addGlassWall(scene, glass, width, wallH, 0, wallH / 2, depth / 2, Math.PI);
    addGlassWall(scene, glass, width, wallH, 0, wallH / 2, -depth / 2, 0);
    var postMat = new THREE.MeshStandardMaterial({ color: 0x9aabba, metalness: 0.75, roughness: 0.28 });
    var capMat = new THREE.MeshBasicMaterial({ color: 0x8af6ff });
    var hw = width / 2;
    var hd = depth / 2;
    [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]].forEach(function (pair) {
      scene.add(mesh(new THREE.BoxGeometry(0.1, wallH, 0.1), postMat, pair[0], wallH / 2, pair[1]));
      scene.add(mesh(new THREE.BoxGeometry(0.16, 0.05, 0.16), capMat, pair[0], wallH + 0.02, pair[1]));
    });
    var mullion = new THREE.MeshStandardMaterial({ color: 0x6d7c8c, metalness: 0.6, roughness: 0.35, emissive: 0x143848, emissiveIntensity: 0.4 });
    var stepX = width / 4;
    var stepZ = depth / 3;
    var m;
    for (m = 1; m < 4; m += 1) {
      var mx = -width / 2 + m * stepX;
      scene.add(mesh(new THREE.BoxGeometry(0.045, wallH, 0.045), mullion, mx, wallH / 2, depth / 2));
      scene.add(mesh(new THREE.BoxGeometry(0.045, wallH, 0.045), mullion, mx, wallH / 2, -depth / 2));
    }
    for (m = 1; m < 3; m += 1) {
      var mz = -depth / 2 + m * stepZ;
      scene.add(mesh(new THREE.BoxGeometry(0.045, wallH, 0.045), mullion, width / 2, wallH / 2, mz));
      scene.add(mesh(new THREE.BoxGeometry(0.045, wallH, 0.045), mullion, -width / 2, wallH / 2, mz));
    }
    var barMat = new THREE.MeshBasicMaterial({ color: 0x7ad8ee });
    scene.add(mesh(new THREE.BoxGeometry(width * 0.42, 0.025, 0.06), barMat, 0, 4.35, -depth * 0.18));
    scene.add(mesh(new THREE.BoxGeometry(width * 0.42, 0.025, 0.06), barMat, 0, 4.35, depth * 0.18));
    scene.add(mesh(new THREE.BoxGeometry(width, 0.045, 0.07), postMat, 0, wallH, depth / 2));
    scene.add(mesh(new THREE.BoxGeometry(width, 0.045, 0.07), postMat, 0, wallH, -depth / 2));
    scene.add(mesh(new THREE.BoxGeometry(0.07, 0.045, depth), postMat, width / 2, wallH, 0));
    scene.add(mesh(new THREE.BoxGeometry(0.07, 0.045, depth), postMat, -width / 2, wallH, 0));
  }

  function starTexture() {
    var canvas = makeCanvas(32, 32);
    var ctx = canvas.getContext("2d");
    var glow = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    glow.addColorStop(0, "rgba(255,255,255,1)");
    glow.addColorStop(0.4, "rgba(214,232,255,0.75)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 32, 32);
    return canvasTexture(canvas);
  }

  function roadPoint(t, rx, rz, out) {
    var seg = (t % 1) * 4;
    if (seg < 0) seg += 4;
    var lane = Math.floor(seg) % 4;
    var along = seg - Math.floor(seg);
    if (lane === 0) {
      out.x = -rx + along * 2 * rx;
      out.z = rz;
    } else if (lane === 1) {
      out.x = rx;
      out.z = rz - along * 2 * rz;
    } else if (lane === 2) {
      out.x = rx - along * 2 * rx;
      out.z = -rz;
    } else {
      out.x = -rx;
      out.z = -rz + along * 2 * rz;
    }
    return out;
  }

  function addSkyline(scene, layout) {
    state.movers = [];
    var rand = mulberry32(0x5eed);
    var width = layout.width;
    var depth = layout.depth;
    var minRadius = Math.hypot(width, depth) * 0.5 + 2.8;
    var heroes = [
      [0, -1, 46, 4.4, 3.4],
      [0.62, -0.78, 34, 3.2, 2.8],
      [-0.7, -0.62, 40, 3.0, 3.2],
      [1, 0.05, 32, 3.6, 2.8],
      [-1, 0.12, 38, 3.1, 3.2],
      [0.15, 1, 28, 4.0, 3.0],
      [-0.42, 1, 33, 2.8, 2.8],
      [0.82, 0.72, 36, 2.4, 2.4],
    ];
    var buildingCount = 58;
    var buildingGeo = new THREE.BoxGeometry(1, 1, 1);
    var buildingMat = new THREE.MeshStandardMaterial({
      color: 0x121722,
      roughness: 0.9,
      metalness: 0.18,
      emissive: 0x0b1522,
      emissiveIntensity: 0.85,
    });
    var buildings = new THREE.InstancedMesh(buildingGeo, buildingMat, buildingCount);
    buildings.frustumCulled = false;
    var windows = [];
    var signs = [];
    var dummy = new THREE.Object3D();
    var i;
    for (i = 0; i < buildingCount; i += 1) {
      var near = i < 24;
      var radius = near ? minRadius + rand() * 10 : minRadius + 12 + rand() * 26;
      var angle = rand() * Math.PI * 2;
      var x = Math.cos(angle) * radius;
      var z = Math.sin(angle) * radius * (0.82 + rand() * 0.3);
      var bw = near ? 1.1 + rand() * 1.8 : 1.6 + rand() * 3.2;
      var bd = near ? 1.1 + rand() * 1.8 : 1.6 + rand() * 3.2;
      var bh = near ? 12 + rand() * 16 : 18 + Math.pow(rand(), 0.7) * 30;
      if (i < heroes.length) {
        var hero = heroes[i];
        var heroLen = Math.hypot(hero[0], hero[1]) || 1;
        var heroRadius = Math.max(width, depth) * 0.5 + 3.6;
        x = (hero[0] / heroLen) * heroRadius;
        z = (hero[1] / heroLen) * heroRadius;
        bh = hero[2];
        bw = hero[3];
        bd = hero[4];
      }
      if (i % 7 === 0 && i >= heroes.length) {
        bw *= 0.38;
        bd *= 0.38;
        bh *= 1.45;
      }
      var base = -14;
      dummy.position.set(x, base + bh / 2, z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(bw, bh, bd);
      dummy.updateMatrix();
      buildings.setMatrixAt(i, dummy.matrix);
      var n;
      var lit = 4 + Math.floor(rand() * 4);
      for (n = 0; n < lit; n += 1) {
        var wy = base + 3 + rand() * Math.max(bh - 5, 1);
        if (wy < -1 || wy > 34) continue;
        var wx = x;
        var wz = z;
        if (Math.abs(x) > Math.abs(z)) wx -= Math.sign(x) * bw / 2;
        else wz -= Math.sign(z) * bd / 2;
        windows.push({ x: wx, y: wy, z: wz, warm: rand() > 0.62, hot: rand() > 0.9 });
      }
      if (i < heroes.length) {
        var cols = 3;
        var rowsLit = 7;
        var rr;
        var cc;
        for (rr = 0; rr < rowsLit; rr += 1) {
          for (cc = 0; cc < cols; cc += 1) {
            var gy = base + 4 + rr * (bh - 6) / rowsLit;
            if (gy < 0 || gy > 32) continue;
            var gx = x;
            var gz = z;
            var spread = (cc - (cols - 1) / 2) * Math.min(bw, bd) * 0.28;
            if (Math.abs(x) > Math.abs(z)) {
              gx -= Math.sign(x) * bw / 2;
              gz += spread;
            } else {
              gz -= Math.sign(z) * bd / 2;
              gx += spread;
            }
            windows.push({ x: gx, y: gy, z: gz, warm: (rr + cc) % 3 === 0, hot: (rr + cc) % 5 === 0 });
          }
        }
      }
      if (rand() > 0.72 && signs.length < 12) {
        var sx = x;
        var sz = z;
        if (Math.abs(x) > Math.abs(z)) sx -= Math.sign(x) * (bw / 2 + 0.05);
        else sz -= Math.sign(z) * (bd / 2 + 0.05);
        signs.push({ x: sx, y: base + bh * 0.55, z: sz, h: 1.6 + rand() * 3.2, warm: rand() > 0.5 });
      }
    }
    buildings.instanceMatrix.needsUpdate = true;
    scene.add(buildings);

    if (windows.length) {
      var windowMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), windows.length);
      windowMesh.frustumCulled = false;
      var cool = new THREE.Color("#7ee7ff");
      var warm = new THREE.Color("#ffc48a");
      var hot = new THREE.Color("#ff7ad9");
      windows.forEach(function (win, index) {
        dummy.position.set(win.x, win.y, win.z);
        dummy.lookAt(0, win.y, 0);
        dummy.scale.set(0.85 + (index % 3) * 0.1, 0.42, 1);
        dummy.updateMatrix();
        windowMesh.setMatrixAt(index, dummy.matrix);
        windowMesh.setColorAt(index, win.hot ? hot : win.warm ? warm : cool);
      });
      windowMesh.instanceMatrix.needsUpdate = true;
      if (windowMesh.instanceColor) windowMesh.instanceColor.needsUpdate = true;
      scene.add(windowMesh);
    }

    if (signs.length) {
      var signMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), signs.length);
      signMesh.frustumCulled = false;
      var signCool = new THREE.Color("#49f3ff");
      var signWarm = new THREE.Color("#ff5ec8");
      signs.forEach(function (sign, index) {
        dummy.position.set(sign.x, sign.y, sign.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(0.12, sign.h, 0.12);
        dummy.updateMatrix();
        signMesh.setMatrixAt(index, dummy.matrix);
        signMesh.setColorAt(index, sign.warm ? signWarm : signCool);
      });
      signMesh.instanceMatrix.needsUpdate = true;
      if (signMesh.instanceColor) signMesh.instanceColor.needsUpdate = true;
      scene.add(signMesh);
    }

    var droneGeo = {
      body: new THREE.SphereGeometry(0.16, 12, 10),
      eye: new THREE.SphereGeometry(0.055, 8, 6),
      ring: new THREE.TorusGeometry(0.3, 0.018, 6, 20),
    };
    var droneColors = [0x7ee7ff, 0xffc48a, 0xd7b3ff, 0x9af6ff, 0xff8ad4];
    var d;
    for (d = 0; d < droneColors.length; d += 1) {
      var drone = new THREE.Group();
      drone.scale.setScalar(1.7);
      var shell = new THREE.Mesh(droneGeo.body, new THREE.MeshStandardMaterial({ color: 0x1a2430, metalness: 0.7, roughness: 0.28 }));
      var eyeMat = new THREE.MeshBasicMaterial({ color: droneColors[d] });
      var eye = new THREE.Mesh(droneGeo.eye, eyeMat);
      eye.position.z = 0.12;
      var ring = new THREE.Mesh(droneGeo.ring, eyeMat);
      ring.rotation.x = Math.PI / 2;
      drone.add(shell, eye, ring);
      scene.add(drone);
      state.movers.push({
        kind: "drone",
        mesh: drone,
        ring: ring,
        rx: width * 0.5 + 3.2 + d * 1.35,
        rz: depth * 0.5 + 3.4 + (d % 3) * 1.8,
        y: 2.2 + (d % 5) * 0.85,
        speed: 0.18 + d * 0.045,
        spin: d % 2 === 0 ? 1 : 0.82,
        phase: d * 1.3,
      });
    }

    var moteGeo = new THREE.BoxGeometry(0.55, 0.08, 0.16);
    var roadRx = width * 0.5 + 6.5;
    var roadRz = depth * 0.5 + 6.5;
    var mote;
    for (mote = 0; mote < 7; mote += 1) {
      var moteMat = new THREE.MeshBasicMaterial({ color: mote % 2 === 0 ? 0xffc48a : 0x8af0ff });
      var moteMesh = new THREE.Mesh(moteGeo, moteMat);
      scene.add(moteMesh);
      state.movers.push({
        kind: "road",
        mesh: moteMesh,
        rx: roadRx + (mote % 3) * 1.4,
        rz: roadRz + (mote % 2) * 1.6,
        y: -2.4 - (mote % 3) * 1.1,
        speed: 0.045 + mote * 0.008,
        phase: mote * 0.17,
        pos: { x: 0, z: 0 },
      });
    }

    scene.add(mesh(new THREE.CircleGeometry(96, 48), new THREE.MeshBasicMaterial({ color: 0x070910 }), 0, -16.2, 0).rotateX(-Math.PI / 2));
  }

  function addSky(scene) {
    var sky = new THREE.Mesh(
      new THREE.SphereGeometry(150, 28, 18),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        uniforms: {},
        vertexShader: [
          "varying vec3 vPos;",
          "void main() {",
          "  vec4 world = modelMatrix * vec4(position, 1.0);",
          "  vPos = world.xyz;",
          "  gl_Position = projectionMatrix * viewMatrix * world;",
          "}",
        ].join("\n"),
        fragmentShader: [
          "varying vec3 vPos;",
          "void main() {",
          "  float h = normalize(vPos).y;",
          "  vec3 top = vec3(0.03, 0.04, 0.09);",
          "  vec3 horizon = vec3(0.18, 0.22, 0.40);",
          "  vec3 city = vec3(0.36, 0.22, 0.42);",
          "  float lift = smoothstep(-0.02, 0.62, h);",
          "  vec3 color = mix(horizon, top, lift);",
          "  color += city * smoothstep(0.42, -0.25, h) * 0.9;",
          "  gl_FragColor = vec4(color, 1.0);",
          "}",
        ].join("\n"),
      })
    );
    sky.renderOrder = -2;
    sky.frustumCulled = false;
    scene.add(sky);

    var count = 340;
    var positions = new Float32Array(count * 3);
    var rand = mulberry32(0x51a5);
    var s;
    for (s = 0; s < count; s += 1) {
      var theta = rand() * Math.PI * 2;
      var lift = 0.05 + Math.pow(rand(), 0.55) * 0.95;
      var ring = 78 + rand() * 48;
      var planar = Math.sqrt(Math.max(0, 1 - lift * lift));
      positions[s * 3] = Math.cos(theta) * planar * ring;
      positions[s * 3 + 1] = lift * ring;
      positions[s * 3 + 2] = Math.sin(theta) * planar * ring;
    }
    var starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    var stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      map: starTexture(),
      color: 0xeaf4ff,
      size: 2.35,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    }));
    stars.renderOrder = -1;
    stars.frustumCulled = false;
    scene.add(stars);
  }

  function makeArm(side, shared, suit) {
    var shoulder = new THREE.Group();
    shoulder.position.set(side * 0.23, 0.36, 0);
    shoulder.add(mesh(shared.geo.upper, suit, 0, -0.12, 0));
    var elbow = new THREE.Group();
    elbow.position.set(0, -0.24, 0);
    elbow.add(mesh(shared.geo.fore, suit, 0, -0.1, 0));
    elbow.add(mesh(shared.geo.hand, shared.glove, 0, -0.22, 0));
    shoulder.add(elbow);
    return { shoulder: shoulder, elbow: elbow };
  }

  function makeLeg(side, shared, suit) {
    var hip = new THREE.Group();
    hip.position.set(side * 0.1, 0.02, 0);
    hip.add(mesh(shared.geo.thigh, suit, 0, -0.155, 0));
    var knee = new THREE.Group();
    knee.position.set(0, -0.31, 0);
    knee.add(mesh(shared.geo.shin, suit, 0, -0.13, 0));
    knee.add(mesh(shared.geo.foot, shared.glove, 0, -0.28, -0.02));
    hip.add(knee);
    return { hip: hip, knee: knee };
  }

  function buildActor(bot, shared, suit) {
    var actor = new THREE.Group();
    var accent = accentColor(bot);
    var hot = accent.clone().multiplyScalar(1.25);
    var glowMats = [];
    var basicGlows = [];
    var visorMat = accentStandard(accent, 1.2);
    var earMat = accentStandard(accent, 0.7);
    var suitGlow = suit;
    glowMats.push({ mat: suitGlow, base: 0.42 });
    glowMats.push({ mat: visorMat, base: 1.45 });
    glowMats.push({ mat: earMat, base: 0.75 });

    var coreMat = accentBasic(hot);
    var bobbleMat = accentBasic(hot);
    var haloMat = accentBasic(hot);
    var hoverMat = accentBasic(hot);
    basicGlows.push({ mat: coreMat, color: hot.clone() });
    basicGlows.push({ mat: bobbleMat, color: hot.clone() });
    basicGlows.push({ mat: haloMat, color: hot.clone() });
    basicGlows.push({ mat: hoverMat, color: hot.clone() });

    var hover = new THREE.Group();
    hover.position.y = 0.045;
    var hoverRing = mesh(shared.geo.hover, hoverMat, 0, 0, 0);
    hoverRing.rotation.x = Math.PI / 2;
    hover.add(hoverRing);
    actor.add(hover);

    var hip = new THREE.Group();
    actor.add(hip);
    hip.add(mesh(shared.geo.hip, suit, 0, 0.04, 0));
    var chest = new THREE.Group();
    hip.add(chest);
    chest.add(mesh(shared.geo.torso, suit, 0, 0.3, 0));
    chest.add(mesh(shared.geo.core, coreMat, 0, 0.32, -0.16));
    var head = new THREE.Group();
    head.position.set(0, 0.64, 0);
    chest.add(head);
    head.add(mesh(shared.geo.head, shared.helm, 0, 0, 0));
    head.add(mesh(shared.geo.visor, visorMat, 0, 0.02, -0.19));
    head.add(mesh(shared.geo.ear, earMat, -0.2, 0.02, 0));
    head.add(mesh(shared.geo.ear, earMat, 0.2, 0.02, 0));
    var haloSpin = new THREE.Group();
    haloSpin.position.set(0, 0.04, 0.05);
    haloSpin.add(mesh(shared.geo.halo, haloMat, 0, 0, 0));
    head.add(haloSpin);
    var antenna = new THREE.Group();
    antenna.position.set(0.06, 0.16, 0);
    antenna.add(mesh(shared.geo.antenna, shared.metal, 0, 0.08, 0));
    antenna.add(mesh(shared.geo.bobble, bobbleMat, 0, 0.18, 0));
    head.add(antenna);

    var left = makeArm(-1, shared, suit);
    var right = makeArm(1, shared, suit);
    chest.add(left.shoulder, right.shoulder);
    var legL = makeLeg(-1, shared, suit);
    var legR = makeLeg(1, shared, suit);
    hip.add(legL.hip, legR.hip);

    bot.labelCanvas = drawLabel(bot);
    var labelTex = canvasTexture(bot.labelCanvas);
    var label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false }));
    var labelW = clamp(1.15 + bot.displayName.length * 0.042, 1.25, 2.35);
    label.scale.set(labelW, labelW * (bot.labelCanvas.height / bot.labelCanvas.width), 1);
    label.position.set(0, 1.72, 0);
    actor.add(label);

    var bubble = null;
    if (bot.now) {
      bot.bubbleCanvas = drawBubble(bot);
      var bubbleTex = canvasTexture(bot.bubbleCanvas);
      bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: bubbleTex, transparent: true, depthWrite: false }));
      var bubbleW = clamp(1.4 + bot.now.length * 0.012, 1.5, 2.25);
      bubble.scale.set(bubbleW, bubbleW * (300 / 768), 1);
      bubble.position.set(0.88, 1.38, 0);
      actor.add(bubble);
    }

    var shadow = mesh(shared.geo.shadow, new THREE.MeshBasicMaterial({
      map: state.shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.8,
    }), 0, 0.03, 0);
    shadow.rotation.x = -Math.PI / 2;
    actor.add(shadow);

    var hit = mesh(shared.geo.hit, shared.hit, 0, 0.85, 0);
    hit.userData.station = bot.index;
    actor.add(hit);
    state.pickables.push(hit);

    bot.actor = actor;
    bot.label = label;
    bot.bubble = bubble;
    bot.glowMats = glowMats;
    bot.basicGlows = basicGlows;
    bot.joints = {
      hip: hip,
      chest: chest,
      head: head,
      antenna: antenna,
      hover: hover,
      halo: haloSpin,
      left: left,
      right: right,
      legL: legL,
      legR: legR,
    };
    return actor;
  }

  function buildPatrol(bot, place) {
    var lane = place.row % 2 === 0 ? 1 : -1;
    var reach = 1.05 + ((hashText(bot.id || bot.index) >>> 0) % 5) * 0.05;
    var home = { x: 0, z: 1.05 };
    var aisle = { x: 0, z: 1.68 };
    var side = { x: lane * reach, z: 1.68 };
    return {
      home: home,
      keys: [home, aisle, side, aisle, home],
      durs: [1.7, 2.5, 2.5, 1.7, 4.1],
      total: 12.5,
    };
  }

  function buildStation(bot, place, shared) {
    var group = new THREE.Group();
    group.position.set(place.x, 0, place.z);
    var accent = accentColor(bot);
    var rimMat = accentStandard(accent, 0.85);
    bot.glowMats = [];
    group.add(mesh(shared.geo.pedestal, shared.metal, 0, 0.36, -0.28));
    group.add(mesh(shared.geo.deskTop, shared.desk, 0, 0.75, -0.32));
    var rimW = 1.42;
    var rimD = 0.72;
    group.add(mesh(shared.geo.rim, rimMat, 0, 0.785, -0.32 + rimD / 2));
    group.add(mesh(shared.geo.rim, rimMat, 0, 0.785, -0.32 - rimD / 2));
    var sideRimGeo = new THREE.BoxGeometry(0.025, 0.02, rimD);
    group.add(mesh(sideRimGeo, rimMat, rimW / 2, 0.785, -0.32));
    group.add(mesh(sideRimGeo, rimMat, -rimW / 2, 0.785, -0.32));
    group.add(mesh(shared.geo.keys, shared.keys, 0, 0.8, -0.22));

    bot.canvas = makeCanvas(512, 288);
    bot.ctx = bot.canvas.getContext("2d");
    bot.texture = canvasTexture(bot.canvas);
    drawScreen(bot, 0);
    var screenMat = new THREE.MeshBasicMaterial({ map: bot.texture });
    var monitor = new THREE.Group();
    monitor.position.set(0, 1.08, -0.58);
    monitor.rotation.x = -0.2;
    monitor.add(mesh(shared.geo.bezel, shared.bezel, 0, 0, 0));
    monitor.add(mesh(shared.geo.screen, screenMat, 0, 0, 0.04));
    var monitorGlow = new THREE.MeshBasicMaterial({
      color: accent,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    var glowPlane = mesh(shared.geo.glowPlane, monitorGlow, 0, 0, 0.02);
    monitor.add(glowPlane);
    group.add(monitor);
    bot.monitorGlow = monitorGlow;
    bot.screenMat = screenMat;

    var chair = new THREE.Group();
    chair.position.set(0, 0, 0.42);
    chair.add(mesh(shared.geo.chairBase, shared.metal, 0, 0.03, 0));
    chair.add(mesh(shared.geo.chairPost, shared.metal, 0, 0.28, 0));
    chair.add(mesh(shared.geo.chairSeat, shared.suit, 0, 0.5, 0));
    chair.add(mesh(shared.geo.chairBack, shared.suit, 0, 0.78, 0.16));
    group.add(chair);

    var suit = shared.suit.clone();
    suit.color.setHSL(bot.accent.h / 360, 0.32, 0.22);
    suit.emissive = accent.clone();
    suit.emissiveIntensity = 0.2;
    var actor = buildActor(bot, shared, suit);
    if (bot.behavior === "type") actor.position.set(0, 0, 0.34);
    else actor.position.set(0, 0, 1.05);
    group.add(actor);
    bot.glowMats.push({ mat: rimMat, base: 0.9 });

    if (bot.behavior === "type") {
      var light = new THREE.PointLight(accent, 0, 4.8, 2);
      light.position.set(0, 1.25, -0.15);
      group.add(light);
      bot.light = light;
    }

    bot.patrol = buildPatrol(bot, place);
    bot.focus = new THREE.Vector3(place.x, 1.05, place.z);
    var deskHit = mesh(shared.geo.deskHit, shared.hit, 0, 0.7, -0.1);
    deskHit.userData.station = bot.index;
    group.add(deskHit);
    state.pickables.push(deskHit);
    return group;
  }

  function shadowTexture() {
    var canvas = makeCanvas(128, 128);
    var ctx = canvas.getContext("2d");
    var grd = ctx.createRadialGradient(64, 64, 6, 64, 64, 62);
    grd.addColorStop(0, "rgba(0,0,0,0.55)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 128, 128);
    return canvasTexture(canvas);
  }

  function hexColor(value, fallback) {
    var text = fieldText(value);
    if (/^#?[0-9a-fA-F]{6}$/.test(text)) return new THREE.Color(text.charAt(0) === "#" ? text : "#" + text);
    return new THREE.Color(fallback);
  }

  function addZoneBorder(scene, zone, color) {
    var mat = new THREE.MeshBasicMaterial({ color: color });
    var y = 0.046;
    var t = 0.05;
    var hw = zone.w / 2;
    var hd = zone.d / 2;
    scene.add(mesh(new THREE.BoxGeometry(zone.w, 0.025, t), mat, zone.x, y, zone.z + hd));
    scene.add(mesh(new THREE.BoxGeometry(zone.w, 0.025, t), mat, zone.x, y, zone.z - hd));
    scene.add(mesh(new THREE.BoxGeometry(t, 0.025, zone.d), mat, zone.x + hw, y, zone.z));
    scene.add(mesh(new THREE.BoxGeometry(t, 0.025, zone.d), mat, zone.x - hw, y, zone.z));
  }

  function addZoneFloorLabel(scene, zone, color) {
    var canvas = makeCanvas(1024, 180);
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, 1024, 180);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(255,255,255,0.35)";
    ctx.shadowBlur = 8;
    ctx.fillStyle = "#f7fbff";
    var label = zone.label || "";
    fitFont(ctx, label, 960, 86, 28, "700");
    ctx.fillText(ellipsize(ctx, label, 960), 512, 90);
    var tex = canvasTexture(canvas);
    var planeW = Math.min(Math.max(zone.w * 0.84, 2.4), 8.4);
    var planeH = planeW * (180 / 1024);
    var labelMesh = mesh(
      new THREE.PlaneGeometry(planeW, planeH),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
      zone.x,
      0.062,
      zone.z + zone.d / 2 - planeH / 2 - 0.32
    );
    labelMesh.rotation.x = -Math.PI / 2;
    labelMesh.renderOrder = 2;
    scene.add(labelMesh);
  }

  function addExecutiveRoom(scene, zone, color) {
    var h = 2.58;
    var inset = 0.16;
    var x0 = zone.x - zone.w / 2 + inset;
    var x1 = zone.x + zone.w / 2 - inset;
    var z0 = zone.z - zone.d / 2 + inset;
    var z1 = zone.z + zone.d / 2 - inset;
    var w = Math.max(x1 - x0, 0.4);
    var d = Math.max(z1 - z0, 0.4);
    var cx = (x0 + x1) / 2;
    var cz = (z0 + z1) / 2;
    var glass = new THREE.MeshStandardMaterial({
      color: 0xffd6ea,
      metalness: 0.08,
      roughness: 0.04,
      transparent: true,
      opacity: 0.16,
      emissive: color.clone(),
      emissiveIntensity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    addGlassWall(scene, glass, w, h, cx, h / 2, z0, 0);
    addGlassWall(scene, glass, d, h, x0, h / 2, cz, Math.PI / 2);
    addGlassWall(scene, glass, d, h, x1, h / 2, cz, -Math.PI / 2);
    var door = Math.min(1.7, w * 0.36);
    var side = (w - door) / 2;
    if (side > 0.25) {
      addGlassWall(scene, glass, side, h, x0 + side / 2, h / 2, z1, Math.PI);
      addGlassWall(scene, glass, side, h, x1 - side / 2, h / 2, z1, Math.PI);
    }
    var trim = new THREE.MeshBasicMaterial({ color: color });
    scene.add(mesh(new THREE.BoxGeometry(door, 0.07, 0.06), trim, cx, h - 0.05, z1));
    scene.add(mesh(new THREE.BoxGeometry(w, 0.045, 0.05), trim, cx, h, z0));
    scene.add(mesh(new THREE.BoxGeometry(w, 0.045, 0.05), trim, cx, h, z1));
    scene.add(mesh(new THREE.BoxGeometry(0.05, 0.045, d), trim, x0, h, cz));
    scene.add(mesh(new THREE.BoxGeometry(0.05, 0.045, d), trim, x1, h, cz));
    [[x0, z0], [x1, z0], [x0, z1], [x1, z1]].forEach(function (pair) {
      scene.add(mesh(new THREE.BoxGeometry(0.07, h, 0.07), trim, pair[0], h / 2, pair[1]));
    });
    state.execAnchor = new THREE.Vector3(zone.x, 1.35, zone.z);
    state.execTheta = 0.42;
  }

  function drawWorkingNow(ctx, canvas) {
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#070b12";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#d5c6ff";
    ctx.fillRect(36, 28, w - 72, 6);
    var busy = [];
    var i;
    for (i = 0; i < roster.length; i += 1) {
      if (roster[i].now) busy.push(roster[i]);
    }
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.font = "700 64px sans-serif";
    ctx.fillStyle = "#d5c6ff";
    var title = "WORKING NOW";
    ctx.fillText(title, 48, 118);
    ctx.fillStyle = "#f7fbff";
    ctx.fillText(String(busy.length), 72 + ctx.measureText(title).width, 118);

    var rowTop = 168;
    var rowH = 76;
    var maxRows = Math.max(1, Math.floor((h - rowTop - 36) / rowH));
    var shown = busy.slice(0, maxRows);
    var extra = busy.length - shown.length;
    if (extra > 0 && shown.length === maxRows) {
      shown = busy.slice(0, Math.max(0, maxRows - 1));
      extra = busy.length - shown.length;
    }
    var nameLimit = Math.min(460, w * 0.34);
    shown.forEach(function (bot, index) {
      var y = rowTop + index * rowH;
      var accent = hslCss(bot.accent);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(70, y + 18, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "700 40px sans-serif";
      ctx.fillStyle = accent;
      ctx.fillText(ellipsize(ctx, bot.displayName, nameLimit), 102, y + 32);
      ctx.font = "400 36px sans-serif";
      ctx.fillStyle = "#e7f2f8";
      ctx.fillText(ellipsize(ctx, bot.now, w - nameLimit - 180), 120 + nameLimit, y + 32);
    });
    if (extra > 0) {
      ctx.font = "400 32px sans-serif";
      ctx.fillStyle = "#93a7b6";
      ctx.fillText("and " + extra + " more", 102, rowTop + shown.length * rowH + 32);
    }
  }

  function paintWorkingBoard() {
    if (!state.workCtx || !state.workCanvas) return;
    drawWorkingNow(state.workCtx, state.workCanvas);
    if (state.workTex) state.workTex.needsUpdate = true;
  }

  function paintActivityWall() {
    if (!state.activityCtx || !state.activityCanvas) return;
    var next = drawWall(data, heat);
    state.activityCtx.clearRect(0, 0, state.activityCanvas.width, state.activityCanvas.height);
    state.activityCtx.drawImage(next, 0, 0);
    if (state.activityTex) state.activityTex.needsUpdate = true;
  }

  function addWorkingBoard(scene, layout) {
    var canvas = makeCanvas(1400, 760);
    state.workCanvas = canvas;
    state.workCtx = canvas.getContext("2d");
    drawWorkingNow(state.workCtx, canvas);
    var tex = canvasTexture(canvas);
    state.workTex = tex;
    var boardH = 2.35;
    var boardW = boardH * (1400 / 760);
    var x = -layout.width / 2 + 0.7;
    var y = 2.15;
    var z = 0;
    var board = mesh(new THREE.PlaneGeometry(boardW, boardH), new THREE.MeshBasicMaterial({ map: tex }), x, y, z);
    board.rotation.y = Math.PI / 2;
    var frame = mesh(
      new THREE.PlaneGeometry(boardW + 0.18, boardH + 0.18),
      new THREE.MeshStandardMaterial({ color: 0x12141c, metalness: 0.4, roughness: 0.42, emissive: 0x24143a, emissiveIntensity: 0.55 }),
      x - 0.05,
      y,
      z
    );
    frame.rotation.y = Math.PI / 2;
    scene.add(frame, board);
    var glow = new THREE.PointLight(0xd5c6ff, 1.1, 10, 2);
    glow.position.set(x + 1.4, y, z);
    scene.add(glow);
    state.boardFocus = new THREE.Vector3(x + 0.2, y, z);
    state.boardTheta = 1.2;
  }

  function addFloorZones(scene, layout) {
    if (!layout || !layout.zones) return;
    layout.zones.forEach(function (zone) {
      var color = hexColor(zone.color, "#8aa4b8");
      var carpetMat = new THREE.MeshStandardMaterial({
        color: color.clone().multiplyScalar(0.16),
        emissive: color.clone(),
        emissiveIntensity: 0.14,
        roughness: 0.94,
        metalness: 0.04,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      var carpet = mesh(
        new THREE.PlaneGeometry(Math.max(zone.w - 0.16, 0.4), Math.max(zone.d - 0.16, 0.4)),
        carpetMat,
        zone.x,
        0.02,
        zone.z
      );
      carpet.rotation.x = -Math.PI / 2;
      carpet.receiveShadow = false;
      scene.add(carpet);
      addZoneBorder(scene, zone, color);
      addZoneFloorLabel(scene, zone, color);
      if (zone.executive) addExecutiveRoom(scene, zone, color);
    });
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
    renderer.toneMappingExposure = 1.18;
    renderer.setClearColor(0x070b14);
    state.renderer = renderer;
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b14);
    scene.fog = new THREE.FogExp2(0x12182c, 0.0048);
    state.scene = scene;
    var layout = state.officeLayout || layoutFor(roster.length);
    state.layout = layout;
    var span = Math.max(layout.width, layout.depth);
    var camera = new THREE.PerspectiveCamera(42, 1, 0.08, 800);
    state.camera = camera;
    var zoned = !!layout.zoned;
    var theta0 = zoned ? 0.98 : 0.38;
    var phi0 = zoned ? 1.06 : 1.38;
    var radius0 = zoned ? Math.max(span * 0.5, 14) : Math.max(span * 0.98, 16);
    var home = new THREE.Vector3(0, zoned ? 1.35 : 2.35, 0);
    state.view = {
      theta: theta0,
      targetTheta: theta0,
      phi: phi0,
      targetPhi: phi0,
      radius: radius0,
      targetRadius: radius0,
      span: span,
      tourLook: null,
      minR: 3.3,
      maxR: Math.max(span * 3.6, 48),
      closeR: 5.5,
      look: home.clone(),
      home: home,
      wideTheta: theta0,
      widePhi: phi0,
      wideRadius: radius0,
      lookAtBot: null,
      lookY: null,
      resumeAt: 0,
    };
    var pi = Math.PI;
    scene.add(new THREE.AmbientLight(0xb7c9da, 0.42 * pi));
    scene.add(new THREE.HemisphereLight(0xc5e6ff, 0x22160e, 0.78 * pi));
    var key = new THREE.DirectionalLight(0xe7f2ff, 1.05 * pi);
    key.position.set(6, 14, 8);
    scene.add(key);
    var rimCool = new THREE.DirectionalLight(0x67e7ff, 1.2 * pi);
    rimCool.position.set(-14, 7, -10);
    scene.add(rimCool);
    var rimWarm = new THREE.DirectionalLight(0xffb07a, 0.82 * pi);
    rimWarm.position.set(12, 5, 10);
    scene.add(rimWarm);

    addSky(scene);
    addSkyline(scene, layout);
    var shared = buildShared();
    state.shadowTex = shadowTexture();
    addShell(scene, shared, layout);
    if (layout.zoned) addFloorZones(scene, layout);
    roster.forEach(function (bot, index) {
      var place = layout.places[index] || { x: 0, z: 0, row: 0, col: 0 };
      scene.add(buildStation(bot, place, shared));
    });
    if (layout.zoned) addWorkingBoard(scene, layout);

    var wallCanvas = drawWall(data, heat);
    state.activityCanvas = wallCanvas;
    state.activityCtx = wallCanvas.getContext("2d");
    var wallTex = canvasTexture(wallCanvas);
    state.activityTex = wallTex;
    var screenW = Math.min(Math.max(layout.width * 0.46, 6.2), 8.2);
    var screenH = screenW * (520 / 1400);
    var wall = mesh(
      new THREE.PlaneGeometry(screenW, screenH),
      new THREE.MeshBasicMaterial({ map: wallTex }),
      0,
      1.15 + screenH / 2,
      -layout.depth / 2 + 1.15
    );
    var frame = mesh(
      new THREE.PlaneGeometry(screenW + 0.16, screenH + 0.16),
      new THREE.MeshStandardMaterial({ color: 0x101820, metalness: 0.4, roughness: 0.45, emissive: 0x083040, emissiveIntensity: 0.4 }),
      0,
      wall.position.y,
      wall.position.z - 0.04
    );
    scene.add(frame, wall);

    var selectRing = mesh(
      new THREE.RingGeometry(0.7, 0.84, 40),
      new THREE.MeshBasicMaterial({ color: 0x9af6ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide }),
      0,
      0.045,
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

  function resizeBloom() {
    if (!state.bloom || !state.renderer) return;
    if (!state.buf) state.buf = new THREE.Vector2();
    state.renderer.getDrawingBufferSize(state.buf);
    var width = Math.max(1, Math.floor(state.buf.x));
    var height = Math.max(1, Math.floor(state.buf.y));
    var blurW = Math.max(1, Math.floor(width * 0.5));
    var blurH = Math.max(1, Math.floor(height * 0.5));
    state.bloom.sceneRT.setSize(width, height);
    state.bloom.brightRT.setSize(blurW, blurH);
    state.bloom.blurA.setSize(blurW, blurH);
    state.bloom.blurB.setSize(blurW, blurH);
    state.bloom.texel.set(1.35 / blurW, 1.35 / blurH);
  }

  function resize() {
    if (!state.renderer || !state.camera) return;
    var width = window.innerWidth;
    var height = Math.max(window.innerHeight, 1);
    var cap = state.quality === "low" ? 1 : 1.35;
    if (width < 900) cap = Math.min(cap, 1.1);
    var ratio = Math.min(window.devicePixelRatio || 1, cap);
    state.renderer.setPixelRatio(ratio);
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / Math.max(height, 1);
    state.camera.updateProjectionMatrix();
    resizeBloom();
  }

  function readQuality() {
    try {
      return localStorage.getItem("mission-control-quality") === "low" ? "low" : "high";
    } catch (err) {
      return "high";
    }
  }

  function applyQuality(mode) {
    state.quality = mode === "low" ? "low" : "high";
    try {
      localStorage.setItem("mission-control-quality", state.quality);
    } catch (err) {
      /* storage can be blocked; the button still switches for this visit */
    }
    var button = document.getElementById("quality");
    if (button) {
      var low = state.quality === "low";
      button.textContent = low ? "Glow: low" : "Glow: high";
      button.setAttribute("aria-pressed", low ? "true" : "false");
      button.title = low
        ? "Bloom is off and the picture uses fewer pixels."
        : "Bloom is on. Switch to low if the picture stutters.";
    }
    if (state.renderer) resize();
  }

  function pauseAuto() {
    if (state.view) state.view.resumeAt = performance.now() + 8000;
  }

  function paintTour() {
    var button = document.getElementById("tour");
    if (!button) return;
    button.textContent = state.tourOn ? "Tour: on" : "Tour: off";
    button.setAttribute("aria-pressed", state.tourOn ? "true" : "false");
  }

  function setTour(on) {
    state.tourOn = !!on;
    if (state.tourOn) state.tourTime = 0;
    else if (state.view) state.view.tourLook = null;
    paintTour();
  }

  function executiveLook() {
    var i;
    for (i = 0; i < roster.length; i += 1) {
      if (roster[i].executive && roster[i].focus) return roster[i].focus.clone();
    }
    if (state.execAnchor) return state.execAnchor.clone();
    return state.view && state.view.home ? state.view.home.clone() : new THREE.Vector3();
  }

  function tourStops() {
    var view = state.view;
    var wideLook = view.home.clone();
    var wideRadius = view.wideRadius || Math.max((view.span || 18) * 0.5, 14);
    var wideTheta = view.wideTheta != null ? view.wideTheta : 0.98;
    var widePhi = view.widePhi != null ? view.widePhi : 1.06;
    var boardLook = state.boardFocus ? state.boardFocus.clone() : wideLook.clone();
    return [
      { look: wideLook, theta: wideTheta, phi: widePhi, radius: wideRadius, dur: 6.2 },
      { look: boardLook, theta: state.boardTheta || 1.2, phi: 1.22, radius: 9.2, dur: 6.4 },
      { look: executiveLook(), theta: state.execTheta || 0.42, phi: 1.08, radius: 7.6, dur: 6.4 },
      { look: wideLook, theta: wideTheta, phi: widePhi, radius: wideRadius, dur: 5.2 },
    ];
  }

  function sampleTour(time) {
    var stops = tourStops();
    var total = 0;
    var i;
    for (i = 0; i < stops.length; i += 1) total += stops[i].dur;
    var t = wrapPositive(time, total || 1);
    for (i = 0; i < stops.length; i += 1) {
      var dur = stops[i].dur;
      if (t <= dur || i === stops.length - 1) {
        var from = stops[i];
        var to = stops[(i + 1) % stops.length];
        var u = dur <= 0 ? 1 : Math.min(t / dur, 1);
        var s = u * u * (3 - 2 * u);
        return {
          theta: from.theta + wrapAngle(to.theta - from.theta) * s,
          phi: from.phi + (to.phi - from.phi) * s,
          radius: from.radius + (to.radius - from.radius) * s,
          look: from.look.clone().lerp(to.look, s),
        };
      }
      t -= dur;
    }
    return { theta: 0.82, phi: 0.98, radius: 18, look: state.view.home.clone() };
  }

  function updateCamera(dt) {
    var view = state.view;
    if (!view || !state.camera) return;
    var touring = state.tourOn && state.selected < 0 && performance.now() > view.resumeAt;
    if (touring) {
      state.tourTime += dt;
      var sample = sampleTour(state.tourTime);
      view.targetTheta = sample.theta;
      view.targetPhi = clamp(sample.phi, 0.36, 1.48);
      view.targetRadius = clamp(sample.radius, view.minR, view.maxR);
      view.tourLook = sample.look;
    } else if (!motionQuery.matches && !state.tourOn && state.selected < 0 && view.lookAtBot == null && performance.now() > view.resumeAt) {
      view.targetTheta += dt * 0.028;
    }
    var glide = 1 - Math.exp(-dt * 5.5);
    view.theta += wrapAngle(view.targetTheta - view.theta) * glide;
    view.phi += (view.targetPhi - view.phi) * glide;
    view.radius += (view.targetRadius - view.radius) * glide;
    var desired = view.home;
    if (state.selected >= 0 && roster[state.selected] && roster[state.selected].focus) desired = roster[state.selected].focus;
    else if (view.lookAtBot != null && roster[view.lookAtBot] && roster[view.lookAtBot].focus) desired = roster[view.lookAtBot].focus;
    else if (state.tourOn && view.tourLook && state.selected < 0) desired = view.tourLook;
    else if (view.lookHold) desired = view.lookHold;
    if (view.lookY != null) {
      if (!state.aimLook) state.aimLook = new THREE.Vector3();
      state.aimLook.copy(desired);
      state.aimLook.y = view.lookY;
      desired = state.aimLook;
    }
    view.look.lerp(desired, 1 - Math.exp(-dt * 2.6));
    var sinP = Math.sin(view.phi);
    state.camera.position.set(
      view.look.x + view.radius * sinP * Math.sin(view.theta),
      view.look.y + view.radius * Math.cos(view.phi),
      view.look.z + view.radius * sinP * Math.cos(view.theta)
    );
    state.camera.lookAt(view.look);
  }

  function wrapPositive(value, total) {
    if (!total) return 0;
    var mod = value % total;
    return mod < 0 ? mod + total : mod;
  }

  function samplePatrol(bot, time) {
    var keys = bot.patrol.keys;
    var durs = bot.patrol.durs;
    var t = wrapPositive(time + bot.phase * 2.15, bot.patrol.total);
    var i;
    for (i = 0; i < keys.length; i += 1) {
      var dur = durs[i];
      if (t <= dur || i === keys.length - 1) {
        var from = keys[i];
        var to = keys[(i + 1) % keys.length];
        var u = dur <= 0 ? 1 : Math.min(t / dur, 1);
        var s = u * u * (3 - 2 * u);
        var dx = to.x - from.x;
        var dz = to.z - from.z;
        return {
          x: from.x + dx * s,
          z: from.z + dz * s,
          moving: Math.hypot(dx, dz) > 0.08,
          yaw: Math.atan2(-dx, -dz),
        };
      }
      t -= dur;
    }
    return { x: keys[0].x, z: keys[0].z, moving: false, yaw: 0 };
  }

  function dampAngle(current, target, dt, speed) {
    var k = 1 - Math.exp(-speed * Math.max(dt, 0));
    return current + wrapAngle(target - current) * k;
  }

  function applyGlow(bot, time, scale) {
    var gain = glowStrength(glowLevel(bot.presence));
    var pulse = 1;
    if (scale && (bot.presence === "working" || bot.presence === "recent")) {
      pulse = 0.86 + Math.sin(time * 4.6 + bot.phase) * 0.14;
    }
    var level = gain * pulse;
    var selected = bot.index === state.selected;
    var i;
    for (i = 0; i < bot.glowMats.length; i += 1) {
      var item = bot.glowMats[i];
      item.mat.emissiveIntensity = item.base * level;
      if (selected) item.mat.emissiveIntensity = Math.max(item.mat.emissiveIntensity, 0.85);
    }
    for (i = 0; i < bot.basicGlows.length; i += 1) {
      var basic = bot.basicGlows[i];
      var boost = selected ? Math.max(level, 0.55) : level;
      basic.mat.color.copy(basic.color).multiplyScalar(boost);
    }
    if (bot.monitorGlow) {
      var bright = bot.presence === "working" || bot.presence === "recent";
      bot.monitorGlow.opacity = bright ? 0.42 * pulse : gain * 0.18;
    }
    if (bot.light) bot.light.intensity = level * Math.PI * 1.8;
  }

  function poseActor(bot, time, dt, scale) {
    if (!bot.actor || !bot.joints) return;
    var joints = bot.joints;
    var typing = bot.behavior === "type";
    var walking = false;
    var hipBase = typing ? 0.4 : 0.64;
    var bob = 0;
    if (scale && bot.behavior === "bob") bob = Math.sin(time * 1.7 + bot.phase) * 0.05;
    else if (scale && bot.behavior === "look") bob = Math.sin(time * 1.15 + bot.phase) * 0.018;
    else if (scale && typing) bob = Math.sin(time * 2.1 + bot.phase) * 0.012;

    if (bot.behavior === "walk") {
      if (!scale) {
        bot.actor.position.set(bot.patrol.home.x, 0, bot.patrol.home.z);
        bot.yaw = dampAngle(bot.yaw, 0, dt, 6);
      } else {
        var sample = samplePatrol(bot, time);
        bot.actor.position.set(sample.x, 0, sample.z);
        walking = sample.moving;
        bot.yaw = dampAngle(bot.yaw, sample.moving ? sample.yaw : 0, dt, 7);
        if (walking) bob += Math.abs(Math.sin(time * 8.4 + bot.phase)) * 0.03;
      }
    } else if (typing) {
      bot.actor.position.set(0, 0, 0.34);
      bot.yaw = dampAngle(bot.yaw, 0, dt, 6);
    } else {
      bot.actor.position.set(0, 0, 1.05);
      bot.yaw = dampAngle(bot.yaw, 0, dt, 6);
    }
    bot.actor.rotation.y = bot.yaw;
    joints.hip.position.y = hipBase + bob;

    var swing = scale && walking ? Math.sin(time * 6.2 + bot.phase) : 0;
    if (typing) {
      joints.legL.hip.rotation.set(1.45, 0, 0.1);
      joints.legR.hip.rotation.set(1.45, 0, -0.1);
      joints.legL.knee.rotation.set(-1.55, 0, 0);
      joints.legR.knee.rotation.set(-1.55, 0, 0);
    } else if (walking) {
      joints.legL.hip.rotation.set(swing * 0.62, 0, 0);
      joints.legR.hip.rotation.set(-swing * 0.62, 0, 0);
      joints.legL.knee.rotation.set(-0.1 - Math.max(0, -swing) * 0.42, 0, 0);
      joints.legR.knee.rotation.set(-0.1 - Math.max(0, swing) * 0.42, 0, 0);
    } else {
      joints.legL.hip.rotation.set(0.05, 0, 0.05);
      joints.legR.hip.rotation.set(0.05, 0, -0.05);
      joints.legL.knee.rotation.set(-0.08, 0, 0);
      joints.legR.knee.rotation.set(-0.08, 0, 0);
    }

    var armWave = 0;
    if (scale && typing) armWave = Math.sin(time * 9.2 + bot.phase);
    if (typing) {
      joints.left.shoulder.rotation.set(1.28 + armWave * 0.1, 0, 0.18);
      joints.right.shoulder.rotation.set(1.28 - armWave * 0.1, 0, -0.18);
      joints.left.elbow.rotation.set(1.25 + armWave * 0.55, 0, 0);
      joints.right.elbow.rotation.set(1.25 - armWave * 0.55, 0, 0);
    } else if (walking) {
      joints.left.shoulder.rotation.set(-swing * 0.28, 0, 0.16);
      joints.right.shoulder.rotation.set(swing * 0.28, 0, -0.16);
      joints.left.elbow.rotation.set(0.28, 0, 0);
      joints.right.elbow.rotation.set(0.28, 0, 0);
    } else {
      var sway = scale && bot.behavior === "bob" ? Math.sin(time * 1.3 + bot.phase) * 0.14 : 0;
      joints.left.shoulder.rotation.set(0.14 + sway, 0, 0.24);
      joints.right.shoulder.rotation.set(0.14 - sway, 0, -0.24);
      joints.left.elbow.rotation.set(0.2, 0, 0);
      joints.right.elbow.rotation.set(0.2, 0, 0);
    }

    var headY = 0;
    var headX = typing ? 0.32 : 0.08;
    if (scale && bot.behavior === "look") {
      headY = Math.sin(time * 0.52 + bot.phase) * 0.95;
      headX += Math.sin(time * 0.33 + bot.phase * 2) * 0.22;
    } else if (scale) {
      headY = Math.sin(time * 0.75 + bot.phase) * (typing ? 0.1 : 0.18);
      headX += Math.sin(time * 1.45 + bot.phase) * 0.045;
    }
    joints.head.rotation.set(headX, headY, 0);
    var twist = 0;
    var lean = 0;
    if (typing) lean = -0.42;
    else if (walking) lean = 0.16;
    if (scale && bot.behavior === "look") twist = Math.sin(time * 0.52 + bot.phase) * 0.3;
    joints.chest.rotation.set(lean, twist, 0);
    if (scale) {
      joints.antenna.rotation.z = Math.sin(time * 1.4 + bot.phase) * 0.18;
      joints.hover.rotation.y = time * (bot.behavior === "bob" ? 1.15 : 0.4);
      joints.halo.rotation.z = time * 0.35;
    }

    var crown = joints.hip.position.y;
    if (bot.label) bot.label.position.set(0, crown + 1.12, 0);
    if (bot.bubble) {
      var floatY = scale ? Math.sin(time * 1.45 + bot.phase) * 0.05 : 0;
      bot.bubble.position.set(1.2, crown + 0.42 + floatY, 0.12);
    }
    bot.actor.getWorldPosition(bot.focus);
    bot.focus.y = 1.08;
    applyGlow(bot, time, scale);
    if (scale && typing) {
      var tick = Math.floor(time * 5);
      if (tick !== bot.screenTick) {
        bot.screenTick = tick;
        drawScreen(bot, time);
      }
    }
  }

  function updateMovers(time) {
    var movers = state.movers;
    var i;
    for (i = 0; i < movers.length; i += 1) {
      var item = movers[i];
      if (item.kind === "drone") {
        var angle = time * item.speed + item.phase;
        item.mesh.position.set(
          Math.cos(angle) * item.rx,
          item.y + Math.sin(time * 0.55 + item.phase) * 0.4,
          Math.sin(angle * item.spin) * item.rz
        );
        item.mesh.rotation.y = -angle;
        item.ring.rotation.z = time * 1.4;
      } else if (item.kind === "road") {
        roadPoint(time * item.speed + item.phase, item.rx, item.rz, item.pos);
        item.mesh.position.set(item.pos.x, item.y, item.pos.z);
      }
    }
  }

  function makeTarget(width, height, depth) {
    var target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
      depthBuffer: depth,
      stencilBuffer: false,
    });
    target.texture.generateMipmaps = false;
    target.texture.minFilter = THREE.LinearFilter;
    target.texture.magFilter = THREE.LinearFilter;
    return target;
  }

  function fullscreenMaterial(fragment, uniforms) {
    var material = new THREE.ShaderMaterial({
      uniforms: uniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      vertexShader: [
        "varying vec2 vUv;",
        "void main() {",
        "  vUv = uv;",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
        "}",
      ].join("\n"),
      fragmentShader: fragment,
    });
    return material;
  }

  function ensureBloom() {
    if (state.bloom || state.bloomFailed) return state.bloom;
    try {
      if (!state.buf) state.buf = new THREE.Vector2();
      state.renderer.getDrawingBufferSize(state.buf);
      var width = Math.max(1, Math.floor(state.buf.x));
      var height = Math.max(1, Math.floor(state.buf.y));
      var blurW = Math.max(1, Math.floor(width * 0.5));
      var blurH = Math.max(1, Math.floor(height * 0.5));
      var fsScene = new THREE.Scene();
      var fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
      fsCam.position.z = 1;
      var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
      quad.frustumCulled = false;
      fsScene.add(quad);
      var brightMat = fullscreenMaterial([
        "uniform sampler2D tDiffuse;",
        "uniform float threshold;",
        "varying vec2 vUv;",
        "void main() {",
        "  vec4 color = texture2D(tDiffuse, vUv);",
        "  float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));",
        "  float keep = smoothstep(threshold, threshold + 0.2, luma);",
        "  gl_FragColor = vec4(color.rgb * keep, 1.0);",
        "}",
      ].join("\n"), {
        tDiffuse: { value: null },
        threshold: { value: 0.58 },
      });
      var blurMat = fullscreenMaterial([
        "uniform sampler2D tDiffuse;",
        "uniform vec2 texel;",
        "varying vec2 vUv;",
        "void main() {",
        "  vec2 step = texel;",
        "  vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;",
        "  sum += texture2D(tDiffuse, vUv + step * 1.384615).rgb * 0.316216;",
        "  sum += texture2D(tDiffuse, vUv - step * 1.384615).rgb * 0.316216;",
        "  sum += texture2D(tDiffuse, vUv + step * 3.230769).rgb * 0.070270;",
        "  sum += texture2D(tDiffuse, vUv - step * 3.230769).rgb * 0.070270;",
        "  gl_FragColor = vec4(sum, 1.0);",
        "}",
      ].join("\n"), {
        tDiffuse: { value: null },
        texel: { value: new THREE.Vector2(1 / blurW, 0) },
      });
      var combineMat = fullscreenMaterial([
        "uniform sampler2D tBase;",
        "uniform sampler2D tBloom;",
        "uniform float strength;",
        "varying vec2 vUv;",
        "void main() {",
        "  vec3 base = texture2D(tBase, vUv).rgb;",
        "  vec3 bloom = texture2D(tBloom, vUv).rgb;",
        "  gl_FragColor = vec4(base + bloom * strength, 1.0);",
        "}",
      ].join("\n"), {
        tBase: { value: null },
        tBloom: { value: null },
        strength: { value: 0.72 },
      });
      state.bloom = {
        sceneRT: makeTarget(width, height, true),
        brightRT: makeTarget(blurW, blurH, false),
        blurA: makeTarget(blurW, blurH, false),
        blurB: makeTarget(blurW, blurH, false),
        fsScene: fsScene,
        fsCam: fsCam,
        quad: quad,
        brightMat: brightMat,
        blurMat: blurMat,
        combineMat: combineMat,
        texel: new THREE.Vector2(1.35 / blurW, 1.35 / blurH),
      };
    } catch (err) {
      console.error(err);
      state.bloomFailed = true;
      state.bloom = null;
    }
    return state.bloom;
  }

  function renderBloom() {
    var bloom = ensureBloom();
    var renderer = state.renderer;
    if (!bloom) {
      renderer.setRenderTarget(null);
      renderer.render(state.scene, state.camera);
      return;
    }
    renderer.setRenderTarget(bloom.sceneRT);
    renderer.render(state.scene, state.camera);
    bloom.quad.material = bloom.brightMat;
    bloom.brightMat.uniforms.tDiffuse.value = bloom.sceneRT.texture;
    renderer.setRenderTarget(bloom.brightRT);
    renderer.render(bloom.fsScene, bloom.fsCam);
    var source = bloom.brightRT;
    var pass;
    for (pass = 0; pass < 4; pass += 1) {
      var horizontal = pass % 2 === 0;
      bloom.blurMat.uniforms.tDiffuse.value = source.texture;
      bloom.blurMat.uniforms.texel.value.set(horizontal ? bloom.texel.x : 0, horizontal ? 0 : bloom.texel.y);
      bloom.quad.material = bloom.blurMat;
      var dest = horizontal ? bloom.blurA : bloom.blurB;
      renderer.setRenderTarget(dest);
      renderer.render(bloom.fsScene, bloom.fsCam);
      source = dest;
    }
    bloom.quad.material = bloom.combineMat;
    bloom.combineMat.uniforms.tBase.value = bloom.sceneRT.texture;
    bloom.combineMat.uniforms.tBloom.value = source.texture;
    renderer.setRenderTarget(null);
    renderer.render(bloom.fsScene, bloom.fsCam);
  }

  function renderView() {
    if (state.quality !== "high" || state.bloomFailed) {
      state.renderer.setRenderTarget(null);
      state.renderer.render(state.scene, state.camera);
      return;
    }
    try {
      renderBloom();
    } catch (err) {
      console.error(err);
      state.bloomFailed = true;
      applyQuality("low");
      state.renderer.setRenderTarget(null);
      state.renderer.render(state.scene, state.camera);
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!state.renderer) return;
    var dt = Math.min(state.clock.getDelta(), 0.05);
    if (document.hidden) return;
    state.animTime += dt;
    var time = state.holdTime != null ? state.holdTime : state.animTime + state.timeOffset;
    var scale = motionQuery.matches ? 0 : 1;
    roster.forEach(function (bot) {
      poseActor(bot, time, dt, scale);
    });
    updateCamera(dt);
    updateMovers(scale ? time : 0);
    if (state.selectRing) {
      if (state.selected >= 0 && roster[state.selected] && roster[state.selected].focus) {
        var focus = roster[state.selected].focus;
        state.selectRing.visible = true;
        state.selectRing.position.set(focus.x, 0.05, focus.z);
        state.selectRing.material.opacity = scale ? 0.62 + Math.sin(time * 3) * 0.28 : 0.9;
      } else {
        state.selectRing.visible = false;
      }
    }
    renderView();
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
    var tipNodes = [el("strong", null, bot.displayName)];
    if (bot.zoneLabel) tipNodes.push(el("span", null, bot.zoneLabel));
    tipNodes.push(el("span", null, "Now " + dash(bot.now)));
    tipNodes.push(el("span", null, "Last seen " + dash(bot.lastSeen)));
    tip.replaceChildren.apply(tip, tipNodes);
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
        state.view.targetPhi = clamp(state.view.targetPhi - dy * 0.0036, 0.36, 1.48);
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
      else if (event.key === "ArrowUp") state.view.targetPhi = clamp(state.view.targetPhi - step, 0.36, 1.48);
      else if (event.key === "ArrowDown") state.view.targetPhi = clamp(state.view.targetPhi + step, 0.36, 1.48);
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

  function redrawNameplate(bot) {
    if (!bot.labelCanvas) return;
    var next = drawLabel(bot);
    var ctx = bot.labelCanvas.getContext("2d");
    ctx.clearRect(0, 0, bot.labelCanvas.width, bot.labelCanvas.height);
    ctx.drawImage(next, 0, 0);
    if (bot.label && bot.label.material && bot.label.material.map) bot.label.material.map.needsUpdate = true;
  }

  function syncBubble(bot) {
    if (!bot.actor) return;
    if (!bot.now) {
      if (bot.bubble) bot.bubble.visible = false;
      return;
    }
    if (!bot.bubble) {
      bot.bubbleCanvas = drawBubble(bot);
      var created = canvasTexture(bot.bubbleCanvas);
      bot.bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: created, transparent: true, depthWrite: false }));
      bot.actor.add(bot.bubble);
    } else if (bot.bubbleCanvas) {
      var next = drawBubble(bot);
      var ctx = bot.bubbleCanvas.getContext("2d");
      ctx.clearRect(0, 0, bot.bubbleCanvas.width, bot.bubbleCanvas.height);
      ctx.drawImage(next, 0, 0);
      if (bot.bubble.material && bot.bubble.material.map) bot.bubble.material.map.needsUpdate = true;
      bot.bubble.visible = true;
    }
    var bubbleW = clamp(1.4 + bot.now.length * 0.012, 1.5, 2.25);
    bot.bubble.scale.set(bubbleW, bubbleW * (300 / 768), 1);
  }

  function ensureWorkLight(bot) {
    if (bot.behavior !== "type" || bot.light || !bot.actor || !bot.actor.parent) return;
    var light = new THREE.PointLight(accentColor(bot), 0, 4.8, 2);
    light.position.set(0, 1.25, -0.15);
    bot.actor.parent.add(light);
    bot.light = light;
  }

  function sameBots(next) {
    var bots = next && Array.isArray(next.bots) ? next.bots : [];
    if (bots.length !== roster.length) return false;
    var i;
    for (i = 0; i < bots.length; i += 1) {
      var record = bots[i] && typeof bots[i] === "object" ? bots[i] : {};
      if (fieldText(record.id) !== roster[i].id) return false;
      if (fieldText(record.name) !== roster[i].name) return false;
    }
    return true;
  }

  function applyFresh(next) {
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    var packed;
    try {
      packed = JSON.stringify(next);
    } catch (err) {
      return;
    }
    if (packed === state.dataPacked) return;
    if (!sameBots(next)) {
      window.location.reload();
      return;
    }
    state.dataPacked = packed;
    data = next;
    window.DATA = next;
    var bots = Array.isArray(next.bots) ? next.bots : [];
    roster.forEach(function (entry, index) {
      var record = bots[index] && typeof bots[index] === "object" ? bots[index] : {};
      entry.lastSeen = fieldText(record.lastSeen);
      entry.now = fieldText(record.now);
      entry.presence = presenceOf(record, next.generatedAt);
      entry.behavior = behaviorFor(entry);
      entry.waiting = Array.isArray(next.waiting) ? related(next.waiting, entry.id) : null;
      entry.timeline = Array.isArray(next.timeline) ? related(next.timeline, entry.id) : null;
      entry.routines = Array.isArray(next.routines) ? related(next.routines, entry.id) : null;
      entry.observed = Array.isArray(next.observedRoutines) ? related(next.observedRoutines, entry.id) : null;
      syncBubble(entry);
      ensureWorkLight(entry);
      redrawNameplate(entry);
      if (entry.ctx) drawScreen(entry, state.animTime || 0);
    });
    heat = heatModel(next);
    renderStat(data);
    renderWaiting(data, roster);
    renderFleet(data, roster);
    renderHeat(heat);
    renderTimeline(data, roster);
    renderRoutines(data, roster);
    renderDetail(roster);
    applyQuality(state.quality);
    paintTour();
    paintWorkingBoard();
    paintActivityWall();
  }

  function pullData() {
    if (state.pulling || window.location.protocol === "file:") return Promise.resolve(false);
    state.pulling = true;
    return fetch("data.json", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (next) {
        applyFresh(next);
        return true;
      })
      .catch(function () {
        return false;
      })
      .then(function (ok) {
        state.pulling = false;
        return ok;
      });
  }

  function watchData() {
    window.setInterval(function () { pullData(); }, 15000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) pullData();
    });
  }

  var data = loadData();
  try {
    state.dataPacked = data ? JSON.stringify(data) : "";
  } catch (err) {
    state.dataPacked = "";
  }
  var roster = buildRoster(data);
  state.officeLayout = null;
  if (roster.length) {
    try {
      state.officeLayout = layoutOffice(roster);
    } catch (err) {
      console.error(err);
    }
  }
  var heat = heatModel(data);

  renderStat(data);
  renderWaiting(data, roster);
  renderFleet(data, roster);
  renderHeat(heat);
  renderTimeline(data, roster);
  renderRoutines(data, roster);
  renderTabs();
  document.getElementById("hint").textContent = "Drag to orbit. The view drifts until you do. Scroll or pinch to zoom. Click a bot. Tour, in the header, stays off until you turn it on: wide, the working board, the executive office, then wide again. A now-line sits and types under a holo bubble. The others bob, look around, or walk a short loop. Glow follows last seen against the generated time: bright within 12 hours, dim within 48, dark after that. The working board reads data.json.";

  window.missionControl = {
    roster: roster,
    ready: false,
    stationCount: function () { return roster.length; },
    selectedIndex: function () { return state.selected; },
    select: function (index) { selectIndex(index, "api"); },
    quality: function () { return state.quality; },
    setQuality: function (mode) { applyQuality(mode); },
    tour: function () { return state.tourOn; },
    setTour: function (on) { setTour(on); },
    zones: function () {
      return roster.map(function (bot) {
        return { name: bot.name, zone: bot.zoneLabel || "", executive: !!bot.executive };
      });
    },
    reloadData: function () { return pullData(); },
    boardFocus: function () {
      if (!state.boardFocus) return null;
      return { x: state.boardFocus.x, y: state.boardFocus.y, z: state.boardFocus.z, theta: state.boardTheta || 0 };
    },
    aim: function (partial) {
      if (!state.view || !partial) return;
      if (partial.theta != null) {
        state.view.theta = partial.theta;
        state.view.targetTheta = partial.theta;
      }
      if (partial.phi != null) {
        var phi = clamp(partial.phi, 0.36, 1.48);
        state.view.phi = phi;
        state.view.targetPhi = phi;
      }
      if (partial.radius != null) {
        var radius = clamp(partial.radius, state.view.minR, state.view.maxR);
        state.view.radius = radius;
        state.view.targetRadius = radius;
      }
      if (partial.time != null) {
        state.timeOffset = partial.time - state.animTime;
        state.holdTime = partial.hold ? partial.time : null;
      }
      if (partial.clear && !partial.hold) state.holdTime = null;
      if (partial.lookAt && partial.lookAt.x != null) {
        if (!state.view.lookHold) state.view.lookHold = new THREE.Vector3();
        state.view.lookHold.set(partial.lookAt.x, partial.lookAt.y, partial.lookAt.z);
        state.view.look.copy(state.view.lookHold);
        state.view.lookAtBot = null;
      } else if (partial.lookIndex != null && partial.lookIndex >= 0) {
        state.view.lookAtBot = partial.lookIndex;
        state.view.lookHold = null;
        var framed = roster[partial.lookIndex];
        if (framed && framed.focus) {
          state.view.look.set(framed.focus.x, partial.lookY != null ? partial.lookY : framed.focus.y, framed.focus.z);
        }
        if (partial.lookY != null) state.view.lookY = partial.lookY;
      } else if (partial.clear) {
        state.view.lookAtBot = null;
        state.view.lookY = null;
        state.view.lookHold = null;
        state.view.look.copy(state.view.home);
      }
      if (partial.index != null) selectIndex(partial.index, "api");
      else if (partial.clear) selectIndex(-1, "api");
      pauseAuto();
    },
  };

  state.quality = readQuality();
  paintTour();
  watchData();

  if (typeof THREE === "undefined") {
    showBanner("The 3D library did not load. The panels still show the data file.");
    document.body.dataset.ready = "1";
    window.missionControl.ready = true;
    applyQuality(state.quality);
  } else if (buildScene(data, roster, heat)) {
    bindInput();
    applyQuality(state.quality);
    frame();
  } else {
    document.body.dataset.ready = "1";
    window.missionControl.ready = true;
    applyQuality(state.quality);
  }
})();
