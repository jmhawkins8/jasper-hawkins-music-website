/* Enquiry attribution — remembers how a visitor arrived (Meta/Google ad
   click tags, UTM values) so the enquiry form can say "this one came from
   an ad" whatever the couple ticks in "How did you hear". First touch wins
   for 30 days. Everything is wrapped in try/catch and nothing here is
   awaited by the page or the form: if it fails, the site behaves exactly
   as it did before this file existed. */
(function () {
  try {
    var KEY = 'jhm-attr', DAYS = 30, MAX = 200;
    var KEYS = ['fbclid', 'gclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var expired = function (s) { return !s || !s.ts || (Date.now() - Date.parse(s.ts)) > DAYS * 86400000; };
    var read = function () {
      try { var s = JSON.parse(localStorage.getItem(KEY) || 'null'); return expired(s) ? null : s; } catch (e) { return null; }
    };

    // On every page load: if the address carries ad/UTM tags and we don't
    // already hold a live first touch, remember this one.
    var params = new URLSearchParams(location.search);
    var found = {}, any = false;
    KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v) { found[k] = String(v).slice(0, MAX); any = true; }
    });
    if (any && !read()) {
      found.landing = location.pathname.slice(0, MAX);
      if (document.referrer) found.referrer = document.referrer.slice(0, MAX);
      found.ts = new Date().toISOString();
      try { localStorage.setItem(KEY, JSON.stringify(found)); } catch (e) {}
    }

    // Called by the enquiry form at submit time. Also includes Meta's own
    // click cookie (_fbc, set by the pixel, 90 days) as a fallback for
    // visitors whose first visit predates this script.
    window.jhmAttribution = function () {
      try {
        var s = read();
        var m = document.cookie.match(/(?:^|;\s*)_fbc=([^;]+)/);
        if (m) { s = s || {}; s.fbc = decodeURIComponent(m[1]).slice(0, MAX); }
        return s;
      } catch (e) { return null; }
    };
  } catch (e) {}
})();
