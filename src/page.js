'use strict';

/**
 * The fixed first-party content of the local page. Two literal strings, no
 * file system, no external assets, no analytics. The page exists only for
 * bootstrap: it takes a local token into memory and uses it on the service's
 * own API. It renders no sessions and offers no reply controls.
 */

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agentspace (local)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<h1>Agentspace</h1>
<form id="signin">
  <label for="token">Local token</label>
  <input id="token" type="password" autocomplete="off" required>
  <button type="submit">Connect</button>
</form>
<p id="status" role="status"></p>
<script src="/app.js"></script>
</body>
</html>
`;

const PAGE_JS = `'use strict';
(function () {
  // Memory only: the token lives in this variable and in the Authorization
  // header. It is never copied into a URL, browser storage, or any logging.
  var token = '';
  function el(id) { return document.getElementById(id); }
  el('signin').addEventListener('submit', function (event) {
    event.preventDefault();
    token = el('token').value;
    fetch('/sessions', { headers: { authorization: 'Bearer ' + token } })
      .then(function (response) {
        if (!response.ok) throw new Error('status-' + response.status);
        return response.json();
      })
      .then(function () { el('status').textContent = 'connected'; })
      .catch(function () { el('status').textContent = 'token rejected'; });
  });
})();
`;

module.exports = { PAGE_HTML, PAGE_JS };
