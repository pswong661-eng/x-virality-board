(function () {
  function load(src, done) {
    var script = document.createElement("script");
    script.src = src;
    script.onload = done;
    document.body.appendChild(script);
  }

  fetch("data.json", { cache: "no-store" })
    .then(function (response) { return response.json(); })
    .then(function (data) { window.DATA = data; }, function () { window.DATA = undefined; })
    .then(function () {
      load("vendor/three.min.js", function () { load("app.js"); });
    });
})();
