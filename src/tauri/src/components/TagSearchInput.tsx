import { useEffect, useMemo, useRef, useState } from "react";
import { filterSuggestions } from "@aplyx/core/autocomplete.js";
import "./TagSearchInput.css";

/**
 * Search-and-tag input for multi-value preference fields (target
 * companies, preferred locations): type to fuzzy-search a suggestion pool
 * (same filterSuggestions scorer the TUI uses), pick with click/Enter/
 * arrows, and every added value renders as a tag chip in wrapping rows
 * below the search bar — hovering (or focusing) a chip reveals its ×
 * remove button. Free text is always accepted on Enter: the pool drives
 * suggestions, it is never a validated enum (same contract as the TUI's
 * autocomplete). Backspace in an empty input removes the last tag.
 */
export function TagSearchInput({
  id,
  placeholder,
  value,
  onChange,
  suggestions,
}: {
  id: string;
  placeholder?: string;
  value: string[];
  onChange: (value: string[]) => void;
  suggestions: string[];
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => new Set(value.map((v) => v.toLowerCase())), [value]);
  const matches = useMemo(() => {
    const pool = suggestions.filter((s) => !selected.has(s.toLowerCase()));
    return filterSuggestions(query, pool, 8);
  }, [query, suggestions, selected]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // Close the dropdown on any click outside the component.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function add(raw: string) {
    const next = raw.trim();
    if (!next || selected.has(next.toLowerCase())) {
      setQuery("");
      return;
    }
    onChange([...value, next]);
    setQuery("");
    setHighlight(0);
  }

  function remove(tag: string) {
    onChange(value.filter((v) => v !== tag));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && matches.length > 0 && query.trim() && highlight < matches.length) {
        add(matches[highlight]);
      } else if (query.trim()) {
        add(query);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && query === "" && value.length > 0) {
      remove(value[value.length - 1]);
    }
  }

  return (
    <div className="tag-search" ref={rootRef}>
      <div className="tag-search-bar">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-autocomplete="list"
          aria-controls={`${id}-listbox`}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {open && matches.length > 0 && (
          <ul className="tag-search-menu" role="listbox" id={`${id}-listbox`}>
            {matches.map((m, i) => (
              <li key={m} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  className={i === highlight ? "tag-search-option is-highlighted" : "tag-search-option"}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => add(m)}
                >
                  {m}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {value.length > 0 && (
        <ul className="tag-search-tags" aria-label="Selected">
          {value.map((tag) => (
            <li key={tag} className="tag-chip">
              <span className="tag-chip-label" title={tag}>
                {tag}
              </span>
              <button
                type="button"
                className="tag-chip-remove"
                aria-label={`Remove ${tag}`}
                onClick={() => remove(tag)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
