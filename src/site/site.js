/* aplyx.app marketing site: small vanilla JS, no build step, no
 * framework. Two jobs: theme toggle (mirrors the desktop app's own
 * light/dark persistence pattern, see desktop/src/lib/uiPrefs.ts) and
 * scroll-reveal for [data-reveal] sections. The anti-flash theme read
 * lives inline in <head> in each HTML page (must run before first paint),
 * not here; this file only handles the toggle button and its icon. */
(function () {
  function effectiveTheme() {
    var explicit = document.documentElement.dataset.theme;
    if (explicit === "light" || explicit === "dark") return explicit;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function setTheme(next) {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("aplyx.theme", next);
    } catch (e) {
      // localStorage unavailable (private browsing, disabled); theme
      // still applies for this page load, just doesn't persist.
    }
  }

  function toggleTheme() {
    var next = effectiveTheme() === "dark" ? "light" : "dark";
    // Soft cross-fade between palettes where supported; silently applies
    // the change immediately everywhere else, no fallback branch needed.
    if (document.startViewTransition) {
      document.startViewTransition(function () {
        setTheme(next);
      });
    } else {
      setTheme(next);
    }
  }

  // Session-scoped "visited" tracking for genuine inline content links
  // (a.link, see styles.css's comment on why not a real :visited).
  // sessionStorage, not localStorage: resets when the tab/browser session
  // ends, matching "visited in this session" rather than permanent
  // browsing history.
  var VISITED_KEY = "aplyx.visitedLinks";

  function loadVisited() {
    try {
      return JSON.parse(sessionStorage.getItem(VISITED_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function markVisited(href) {
    try {
      var visited = loadVisited();
      if (visited.indexOf(href) === -1) {
        visited.push(href);
        sessionStorage.setItem(VISITED_KEY, JSON.stringify(visited));
      }
    } catch (e) {
      // sessionStorage unavailable; link still navigates fine, just
      // never picks up the visited style this session.
    }
  }

  // Counts a stat number up from 0 to its target value once, the first
  // time it scrolls into view. Parses the leading digits and keeps
  // whatever comes after (a "+" or "%") fixed for the whole animation.
  // A target of 0 (or non-numeric content) is left completely alone;
  // there's nothing to count up to.
  function animateCountUp(el) {
    var match = el.textContent.trim().match(/^(\d+)(.*)$/);
    if (!match) return;
    var target = parseInt(match[1], 10);
    var suffix = match[2];
    if (!target) return;
    var DURATION_MS = 900;
    var start = null;
    function step(timestamp) {
      if (start === null) start = timestamp;
      var progress = Math.min((timestamp - start) / DURATION_MS, 1);
      var eased = 1 - Math.pow(1 - progress, 3); // ease-out-cubic: quick start, settled finish
      el.textContent = Math.round(eased * target) + suffix;
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        el.textContent = target + suffix; // exact final value, no rounding drift
      }
    }
    window.requestAnimationFrame(step);
  }

  // A visitor with no explicit choice (no data-theme attribute; the
  // anti-flash inline script never set one) is following the OS setting
  // purely through the @media(prefers-color-scheme) CSS rules, with no JS
  // involved at all. That's correct for the very first paint, but it means
  // switching the OS's own appearance while this tab is open just repaints
  // instantly, with none of the cross-fade the explicit toggle button gets
  // - the exact inconsistency this listener closes. On a system-level
  // change, and only when no explicit choice exists (an explicit toggle
  // owns data-theme from here on and this must never fight it), briefly
  // set data-theme to the new value inside a view-transition so the same
  // cross-fade plays, then remove the attribute again once it finishes:
  // this was never a user choice, so it must not become a standing
  // override that stops following the OS on the next change.
  function watchSystemTheme() {
    if (!window.matchMedia) return;
    var media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", function (e) {
      var stored = null;
      try {
        stored = localStorage.getItem("aplyx.theme");
      } catch (err) {
        // localStorage unavailable; treat as no explicit choice.
      }
      if (stored === "light" || stored === "dark") return;
      var next = e.matches ? "dark" : "light";
      var root = document.documentElement;
      function revert() {
        root.removeAttribute("data-theme");
      }
      // No fallback branch needed: without View Transition support the
      // @media query has already repainted the page on its own, instantly,
      // the same as it always did before this listener existed.
      if (document.startViewTransition) {
        var vt = document.startViewTransition(function () {
          root.dataset.theme = next;
        });
        vt.finished.then(revert).catch(revert);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var toggle = document.querySelector("[data-theme-toggle]");
    if (toggle) toggle.addEventListener("click", toggleTheme);
    watchSystemTheme();

    var nav = document.querySelector(".site-nav");
    if (nav) {
      window.addEventListener(
        "scroll",
        function () {
          nav.classList.toggle("is-scrolled", window.scrollY > 8);
        },
        { passive: true },
      );
    }

    // Mobile nav hamburger: collapses the Features/Pricing/Install/GitHub
    // links into a dropdown below the 46rem breakpoint (styles.css). Only
    // toggles two classes; the media query itself decides whether any of
    // this is even visible, so nothing here needs to check viewport width.
    var navToggle = document.querySelector("[data-nav-toggle]");
    var navLinks = document.querySelector("[data-nav-links]");
    if (navToggle && navLinks) {
      function closeNavMenu() {
        navToggle.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
        navLinks.classList.remove("is-open");
      }
      navToggle.addEventListener("click", function () {
        var open = navToggle.classList.toggle("is-open");
        navToggle.setAttribute("aria-expanded", open ? "true" : "false");
        navLinks.classList.toggle("is-open", open);
      });
      // A link click navigates away (or is the GitHub external tab);
      // either way, don't leave the panel visibly open behind it / on
      // back-navigation.
      navLinks.querySelectorAll(".nav-link").forEach(function (link) {
        link.addEventListener("click", closeNavMenu);
      });
      document.addEventListener("click", function (e) {
        if (!nav.contains(e.target)) closeNavMenu();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeNavMenu();
      });
    }

    // OS install tabs (/install): a click on a tab shows its matching
    // panel (data-os-tab="mac" <-> data-os-panel="mac") and hides the
    // rest. No-op on pages without any [data-os-tab] elements.
    var osTabs = document.querySelectorAll("[data-os-tab]");
    var osTablist = document.querySelector(".os-tablist");

    // Drive the shared sliding underline (.os-tablist::after) to sit under
    // whichever tab is active: the CSS transitions --tab-x / --tab-w so
    // the indicator travels between tabs instead of blinking.
    function positionOsIndicator() {
      if (!osTablist) return;
      var active = osTablist.querySelector(".os-tab.is-active");
      if (!active) return;
      osTablist.style.setProperty("--tab-x", active.offsetLeft + "px");
      osTablist.style.setProperty("--tab-w", active.offsetWidth + "px");
    }

    osTabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var target = tab.getAttribute("data-os-tab");
        osTabs.forEach(function (t) {
          t.classList.toggle("is-active", t === tab);
        });
        document.querySelectorAll("[data-os-panel]").forEach(function (panel) {
          panel.classList.toggle("is-active", panel.getAttribute("data-os-panel") === target);
        });
        positionOsIndicator();
      });
    });

    if (osTablist) {
      positionOsIndicator();
      // Fonts finishing load or a viewport change move the tab boxes;
      // keep the underline aligned. rAF so the first read happens after
      // layout settles.
      requestAnimationFrame(positionOsIndicator);
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(positionOsIndicator);
      }
      var osResizeTimer;
      window.addEventListener("resize", function () {
        clearTimeout(osResizeTimer);
        osResizeTimer = setTimeout(positionOsIndicator, 120);
      });
    }

    // Copy-to-clipboard buttons on install commands (/install): copies
    // the sibling <pre>'s text and flips the icon to a checkmark briefly.
    // No-op on pages without any [data-copy-button] elements.
    document.querySelectorAll("[data-copy-button]").forEach(function (button) {
      var resetTimer;
      button.addEventListener("click", function () {
        var pre = button.parentElement.querySelector("pre");
        if (!pre || !navigator.clipboard) return;
        navigator.clipboard.writeText(pre.textContent).then(function () {
          button.classList.add("is-copied");
          clearTimeout(resetTimer);
          resetTimer = setTimeout(function () {
            button.classList.remove("is-copied");
          }, 1800);
        });
      });
    });

    // TL;DR / Fine Print switcher (/privacy): one iOS-style toggle plus
    // its two flanking labels, all driving the same [data-view-panel]
    // visibility. Persists like the theme toggle so a returning visitor's
    // choice is remembered. No-op on pages without [data-view-switch].
    var viewSwitch = document.querySelector("[data-view-switch]");
    if (viewSwitch) {
      var VIEW_KEY = "aplyx.privacyView";
      var viewLabels = document.querySelectorAll("[data-view-label]");
      function applyView(view) {
        viewSwitch.setAttribute("aria-checked", view === "legal" ? "true" : "false");
        viewLabels.forEach(function (label) {
          label.classList.toggle("is-active", label.getAttribute("data-view-label") === view);
        });
        document.querySelectorAll("[data-view-panel]").forEach(function (panel) {
          panel.classList.toggle("is-active", panel.getAttribute("data-view-panel") === view);
        });
      }
      function persistView(view) {
        try {
          localStorage.setItem(VIEW_KEY, view);
        } catch (e) {
          // still applies for this page load, just doesn't persist
        }
      }
      var storedView = "plain";
      try {
        storedView = localStorage.getItem(VIEW_KEY) || "plain";
      } catch (e) {
        // localStorage unavailable, defaults to "plain" for this load
      }
      applyView(storedView);
      viewSwitch.addEventListener("click", function () {
        var next = viewSwitch.getAttribute("aria-checked") === "true" ? "plain" : "legal";
        applyView(next);
        persistView(next);
      });
      viewLabels.forEach(function (label) {
        label.addEventListener("click", function () {
          var view = label.getAttribute("data-view-label");
          applyView(view);
          persistView(view);
        });
      });
    }

    // Status-tracking demo (/features): the glow bar trails the mouse
    // across the row of status pills. Only the target position is set
    // here; the actual smoothing is a CSS transition on the glow's own
    // transform (styles.css), not a per-frame JS animation loop.
    var statusDemo = document.querySelector(".status-demo");
    if (statusDemo) {
      var glow = statusDemo.querySelector(".status-demo-glow");
      if (glow) {
        statusDemo.addEventListener("mousemove", function (e) {
          var rect = statusDemo.getBoundingClientRect();
          var x = e.clientX - rect.left - glow.offsetWidth / 2;
          glow.style.transform = "translate(" + x + "px, 0)";
        });
        statusDemo.addEventListener("mouseleave", function () {
          glow.style.transform = "translate(-999px, 0)";
        });
      }
    }

    var visited = loadVisited();
    document.querySelectorAll("a.link[href]").forEach(function (a) {
      if (visited.indexOf(a.getAttribute("href")) !== -1) a.classList.add("is-visited");
      a.addEventListener("click", function () {
        markVisited(a.getAttribute("href"));
      });
    });

    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Stat count-up (/, the home page's stats row): triggers once, the
    // first time the row scrolls into view. Skipped entirely under
    // reduced motion, same as everything else here: the static target
    // values already in the markup are the correct reduced-motion result,
    // nothing needs to run to "finish" them.
    var statsEl = document.querySelector(".stats");
    if (statsEl && !reduceMotion && "IntersectionObserver" in window) {
      var statNumbers = statsEl.querySelectorAll(".stat-number");
      var statsObserver = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            statsObserver.unobserve(entry.target);
            statNumbers.forEach(function (el) {
              animateCountUp(el);
            });
          });
        },
        { threshold: 0.4 },
      );
      statsObserver.observe(statsEl);
    }

    var revealEls = document.querySelectorAll("[data-reveal]");
    if (reduceMotion || !("IntersectionObserver" in window)) {
      revealEls.forEach(function (el) {
        el.classList.add("is-visible");
      });
      return;
    }
    // Cards that enter together (e.g. a whole bento row) reveal in a
    // gentle cascade rather than all snapping in at once, staggered by
    // delaying *when the class is added*, not via a CSS transition-delay
    // (which would linger and make each card's hover feel laggy
    // afterward, since transition-delay isn't scoped to just the initial
    // reveal transition).
    var STAGGER_MS = 70;
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry, i) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          window.setTimeout(function () {
            entry.target.classList.add("is-visible");
          }, i * STAGGER_MS);
        });
      },
      { threshold: 0.15 },
    );
    revealEls.forEach(function (el) {
      observer.observe(el);
    });

    // Safety net: IntersectionObserver callbacks can be delayed or never
    // fire at all in some circumstances (a backgrounded/inactive tab,
    // slow initial layout, browser quirks); since [data-reveal]'s base
    // CSS state is invisible until .is-visible lands, a callback that
    // never comes means permanently blank content instead of a merely
    // missed animation. Force-reveal anything still hidden after a grace
    // period, so the worst case is a skipped fade-in, never a blank page.
    window.setTimeout(function () {
      document.querySelectorAll("[data-reveal]:not(.is-visible)").forEach(function (el) {
        el.classList.add("is-visible");
      });
    }, 2000);
  });
})();
