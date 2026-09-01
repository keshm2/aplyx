/* aplyx.app /changelog: renders docs/CHANGELOG.md live from GitHub's raw
 * content CDN, so every push to main is a push to this page: no build
 * step, no redeploy, nothing to keep in sync by hand. Same "no framework"
 * ethos as site.js: a small hand-rolled parser tuned to this repo's own
 * Keep-a-Changelog-style formatting (see docs/CHANGELOG.md's own header),
 * not a general-purpose markdown engine. */
(function () {
  var root = document.getElementById("changelog-root");
  if (!root) return;

  var REPO = "keshm2/aplyx";
  var BRANCH = "main";
  var RAW_URL = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/docs/CHANGELOG.md";
  var DOCS_BLOB_BASE = "https://github.com/" + REPO + "/blob/" + BRANCH + "/docs/";
  var CACHE_KEY = "aplyx.changelogCache.v1";
  // docs/CHANGELOG.md's bullets are deliberately deep-dive (root cause,
  // repro steps, verification), great for RELEASE.md, too dense for a
  // scannable timeline. Bullets get cut to roughly one line's worth of
  // summary; the full text is one click away via "View on GitHub."
  var BULLET_CHAR_BUDGET = 150;

  var CATEGORY_COLOR = {
    added: "good",
    fixed: "info",
    changed: "special",
    removed: "danger",
    security: "danger",
    deprecated: "danger",
    housekeeping: "neutral",
  };

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Relative links in CHANGELOG.md (e.g. "./RELEASE.md") are relative to
  // the file's own folder (docs/) on GitHub; resolve them to a real blob
  // URL instead of a dead link on this domain.
  function resolveHref(href) {
    if (/^https?:\/\//.test(href) || href.charAt(0) === "#") return href;
    return DOCS_BLOB_BASE + href.replace(/^\.\//, "");
  }

  // Cuts raw (pre-inline) markdown text to a word boundary within budget,
  // then backs off further until every `**`, backtick, and [bracket]/(paren)
  // pair left in the slice is balanced, so inline() below can never render
  // a dangling <strong>/<code>/<a> across the cut point.
  function truncateMarkdown(text, limit) {
    if (text.length <= limit) return text;
    var cut = text.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    var slice = text.slice(0, cut);

    function balanced(s) {
      var bold = (s.match(/\*\*/g) || []).length;
      var code = (s.match(/`/g) || []).length;
      var open = (s.match(/[[(]/g) || []).length;
      var close = (s.match(/[\])]/g) || []).length;
      return bold % 2 === 0 && code % 2 === 0 && open === close;
    }

    while (slice && !balanced(slice)) {
      var lastSpace = slice.lastIndexOf(" ");
      if (lastSpace === -1) return "";
      slice = slice.slice(0, lastSpace);
    }
    return slice.replace(/[\s,;:.\-–—]+$/, "") + "…";
  }

  function inline(text) {
    var html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, label, href) {
      return '<a class="link" href="' + resolveHref(href) + '" target="_blank" rel="noopener">' + label + "</a>";
    });
    return html;
  }

  // Block-level pass: headings, blockquotes, tight bullet lists (2-space
  // indented continuation lines), and flush-left paragraphs: the four
  // shapes docs/CHANGELOG.md actually uses.
  function parseBlocks(markdown) {
    var startIdx = markdown.indexOf("\n## [");
    var body = startIdx === -1 ? markdown : markdown.slice(startIdx + 1);
    var lines = body.replace(/\r\n/g, "\n").split("\n");
    var blocks = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      if (line.indexOf("## ") === 0) {
        blocks.push({ type: "h2", text: line.slice(3).trim() });
        i++;
        continue;
      }
      if (line.indexOf("### ") === 0) {
        blocks.push({ type: "h3", text: line.slice(4).trim() });
        i++;
        continue;
      }
      if (line.indexOf("> ") === 0) {
        var quoteLines = [line.slice(2)];
        i++;
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        blocks.push({ type: "quote", text: quoteLines.join(" ") });
        continue;
      }
      if (line.indexOf("- ") === 0) {
        var items = [];
        var current = line.slice(2);
        i++;
        while (i < lines.length) {
          var l = lines[i];
          if (l.indexOf("- ") === 0) {
            items.push(current);
            current = l.slice(2);
            i++;
          } else if (/^ {2}\S/.test(l)) {
            current += " " + l.slice(2).trim();
            i++;
          } else {
            break;
          }
        }
        items.push(current);
        blocks.push({ type: "ul", items: items });
        continue;
      }
      // Flush-left paragraph: soft-wrapped lines with no marker of their own.
      var para = [line.trim()];
      i++;
      while (i < lines.length && lines[i].trim() && !/^#{2,3} |^- |^> /.test(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      blocks.push({ type: "p", text: para.join(" ") });
    }
    return blocks;
  }

  // Groups the flat block list into per-version sections, each split
  // further into its ### subsections (Added/Fixed/Changed/...). A version
  // heading immediately followed by another (docs/CHANGELOG.md has one
  // such stray duplicate) yields an empty section, dropped at the end.
  function buildVersions(blocks) {
    var versions = [];
    var current = null;
    var currentGroup = null;

    function flush() {
      if (current && current.body.length) versions.push(current);
    }

    blocks.forEach(function (b) {
      if (b.type === "h2") {
        flush();
        var parts = b.text.split(" - ");
        var versionMatch = parts[0].match(/^\[([^\]]+)\]$/);
        current = versionMatch
          ? { version: versionMatch[1], heading: null, date: parts[1] || "", tag: parts[2] || "", body: [] }
          : { version: null, heading: b.text, date: "", tag: "", body: [] };
        currentGroup = null;
        return;
      }
      if (!current) return; // stray content before the first real heading
      if (b.type === "h3") {
        currentGroup = { type: "group", heading: b.text, blocks: [] };
        current.body.push(currentGroup);
        return;
      }
      if (currentGroup) {
        currentGroup.blocks.push(b);
      } else {
        current.body.push(b); // meta paragraph/quote directly under the h2
      }
    });
    flush();
    return versions;
  }

  function categoryColor(heading) {
    var key = heading.trim().toLowerCase();
    return CATEGORY_COLOR[key] || "neutral";
  }

  // metaClass applies only to the bare-paragraph case: the "npm package:
  // ..." line rendered directly under a version header, outside any
  // ###-category group, gets the quieter .changelog-meta treatment.
  function renderBlock(b, metaClass) {
    if (b.type === "ul") {
      return (
        '<ul class="changelog-list">' +
        b.items.map(function (li) {
          return "<li>" + inline(truncateMarkdown(li, BULLET_CHAR_BUDGET)) + "</li>";
        }).join("") +
        "</ul>"
      );
    }
    if (b.type === "quote") {
      return '<blockquote class="changelog-quote"><p>' + inline(b.text) + "</p></blockquote>";
    }
    return "<p" + (metaClass ? ' class="' + metaClass + '"' : "") + ">" + inline(b.text) + "</p>";
  }

  function renderVersion(v, index) {
    var isLatest = index === 0 && !!v.version;
    var headHtml;
    if (v.version) {
      headHtml =
        '<span class="changelog-version">' + escapeHtml(v.version) + "</span>" +
        (isLatest ? '<span class="changelog-latest-badge">Latest</span>' : "") +
        (v.date ? '<time class="changelog-date">' + escapeHtml(v.date) + "</time>" : "") +
        (v.tag ? '<span class="changelog-tag">' + escapeHtml(v.tag) + "</span>" : "");
    } else {
      headHtml = '<span class="changelog-version changelog-version-generic">' + inline(v.heading) + "</span>";
    }

    var bodyHtml = v.body.map(function (item) {
      if (item.type !== "group") return renderBlock(item, "changelog-meta");
      var color = categoryColor(item.heading);
      return (
        '<section class="changelog-group">' +
        '<h3 class="changelog-group-title"><span class="changelog-chip changelog-chip-' + color + '">' +
        escapeHtml(item.heading) +
        "</span></h3>" +
        item.blocks.map(renderBlock).join("") +
        "</section>"
      );
    }).join("");

    return (
      '<article class="changelog-entry' + (isLatest ? " is-latest" : "") + '">' +
      '<div class="changelog-entry-marker"><span class="changelog-dot"></span></div>' +
      '<div class="changelog-entry-body">' +
      '<header class="changelog-entry-head">' + headHtml + "</header>" +
      bodyHtml +
      "</div>" +
      "</article>"
    );
  }

  function render(markdown) {
    var versions = buildVersions(parseBlocks(markdown));
    if (!versions.length) {
      renderError();
      return;
    }
    root.innerHTML = '<div class="changelog-timeline">' + versions.map(renderVersion).join("") + "</div>";
  }

  function renderError(cached) {
    var note = cached
      ? "<p>Couldn't refresh from GitHub just now, showing the last synced copy below.</p>"
      : "";
    root.innerHTML =
      '<div class="changelog-error">' +
      "<p>Couldn't load the live changelog right now.</p>" +
      '<div class="changelog-error-actions">' +
      '<button class="btn btn-secondary" type="button" data-changelog-retry>Retry</button>' +
      '<a class="btn btn-primary" href="https://github.com/keshm2/aplyx/blob/main/docs/CHANGELOG.md" target="_blank" rel="noopener">View on GitHub &rarr;</a>' +
      "</div>" +
      "</div>" +
      note;
    var retry = root.querySelector("[data-changelog-retry]");
    if (retry) retry.addEventListener("click", load);
  }

  function setSyncTime(date) {
    var el = document.querySelector("[data-changelog-sync-time]");
    if (!el) return;
    try {
      el.textContent = "Last synced " + date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (e) {
      el.textContent = "";
    }
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.markdown !== "string") return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function writeCache(markdown, fetchedAt) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ markdown: markdown, fetchedAt: fetchedAt }));
    } catch (e) {
      // localStorage unavailable; page still works, just re-fetches every visit
    }
  }

  function load() {
    var cached = readCache();
    if (cached) {
      render(cached.markdown);
      setSyncTime(new Date(cached.fetchedAt));
    }

    fetch(RAW_URL, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (markdown) {
        var fetchedAt = Date.now();
        // Skip the re-render if nothing changed since the cached paint,
        // avoids a pointless flash on a page that already has this content.
        if (!cached || cached.markdown !== markdown) render(markdown);
        writeCache(markdown, fetchedAt);
        setSyncTime(new Date(fetchedAt));
      })
      .catch(function () {
        if (!cached) renderError(false);
        // else: the cached render already stands, fetch just failed to refresh it silently
      });
  }

  load();
})();
