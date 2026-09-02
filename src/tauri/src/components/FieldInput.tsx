import { useEffect, useMemo, useState } from "react";
import type { FieldDef } from "@aplyx/core/onboarding/fields.js";
import { US_CITIES, rankCitiesByProximity } from "@aplyx/core/data/usCities.js";
import { LEVEL_CATEGORIES } from "@aplyx/core/data/levelCategories.js";
import { DatePickerField } from "./DatePickerField";
import { findRoot, listCompanies } from "../lib/bridge";
import { TagSearchInput } from "./TagSearchInput";
import "./formFields.css";

type FieldValue = string | string[];

/** Company autocomplete pool, loaded once per app session through the
 *  bridge (the directory reads the local install's vetted slug lists via
 *  node:fs, so the webview can't import it directly). Resolves to [] when
 *  there's no local install or the bridge fails; tags then run on free
 *  text alone, same contract as everywhere else: the pool only drives
 *  suggestions, it's never a validated enum. */
let companyPool: Promise<string[]> | undefined;
function getCompanyPool(): Promise<string[]> {
  companyPool ??= findRoot()
    .then((root) => listCompanies(root))
    .catch(() => []);
  return companyPool;
}

export function FieldInput({
  field,
  value,
  onChange,
  homeCity = "",
}: {
  field: FieldDef;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  /** The applicant's home "City, ST", so preferred-location suggestions
   *  can be ranked by proximity to where they live. */
  homeCity?: string;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={field.id}>
        {field.label}
      </label>
      {field.help && <p className="field-help">{field.help}</p>}
      <FieldControl field={field} value={value} onChange={onChange} homeCity={homeCity} />
    </div>
  );
}

function FieldControl({
  field,
  value,
  onChange,
  homeCity,
}: {
  field: FieldDef;
  value: FieldValue;
  onChange: (v: FieldValue) => void;
  homeCity: string;
}) {
  const nearbyCities = useMemo(
    () => (homeCity ? rankCitiesByProximity(US_CITIES, homeCity) : US_CITIES),
    [homeCity],
  );
  switch (field.kind) {
    case "yesno": {
      const current = String(value ?? "");
      return (
        <div className="yesno-toggle" role="group" aria-label={field.label}>
          <button type="button" className={current === "yes" ? "selected" : ""} onClick={() => onChange("yes")}>
            Yes
          </button>
          <button type="button" className={current === "no" ? "selected" : ""} onClick={() => onChange("no")}>
            No
          </button>
        </div>
      );
    }

    case "select3": {
      const current = String(value ?? "");
      const options = field.options ?? [];
      return (
        <div className="yesno-toggle" role="group" aria-label={field.label}>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={current === opt.value ? "selected" : ""}
              onClick={() => onChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      );
    }

    case "levels": {
      const selected = new Set(Array.isArray(value) ? value : []);
      const toggle = (id: string) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onChange(LEVEL_CATEGORIES.filter((c) => next.has(c.id)).map((c) => c.id));
      };
      return (
        <div className="checkbox-group" role="group" aria-label={field.label}>
          {LEVEL_CATEGORIES.map((cat) => (
            <label key={cat.id} className="checkbox-row">
              <input type="checkbox" checked={selected.has(cat.id)} onChange={() => toggle(cat.id)} />
              <span>
                {cat.label}
                {cat.experienceHint ? <span className="field-help"> ({cat.experienceHint})</span> : null}
              </span>
            </label>
          ))}
          {selected.size === 0 ? <p className="field-help">Pick at least one.</p> : null}
        </div>
      );
    }

    case "select": {
      const current = String(value ?? "");
      const options = field.options ?? [];
      return (
        <select
          id={field.id}
          className="field-select"
          value={current}
          onChange={(e) => onChange(e.currentTarget.value)}
        >
          <option value="">Prefer not to say</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }

    case "multi-location":
      return (
        <TagSearchInput
          id={field.id}
          placeholder={field.placeholder}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          suggestions={nearbyCities}
        />
      );

    case "multi-company":
      return (
        <CompanyTagInput
          id={field.id}
          placeholder={field.placeholder}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
        />
      );

    case "roles": {
      const current = Array.isArray(value) ? value.join(", ") : "";
      return (
        <input
          id={field.id}
          type="text"
          placeholder={field.placeholder}
          defaultValue={current}
          onBlur={(e) =>
            onChange(
              e.currentTarget.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      );
    }

    case "location":
      // Single-value city field: native datalist suggestions over the same
      // city pool the multi-location tags use; free text always accepted.
      return (
        <>
          <input
            id={field.id}
            type="text"
            list={`${field.id}-cities`}
            placeholder={field.placeholder}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.currentTarget.value)}
          />
          <datalist id={`${field.id}-cities`}>
            {US_CITIES.map((city) => (
              <option key={city} value={city} />
            ))}
          </datalist>
        </>
      );

    case "date":
      return (
        <DatePickerField
          id={field.id}
          value={String(value ?? "")}
          onChange={onChange}
          placeholder={field.placeholder}
        />
      );

    case "text":
    default:
      return (
        <input
          id={field.id}
          type="text"
          placeholder={field.placeholder}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
  }
}

function CompanyTagInput({
  id,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  placeholder?: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [pool, setPool] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getCompanyPool().then((companies) => {
      if (!cancelled) setPool(companies);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TagSearchInput id={id} placeholder={placeholder} value={value} onChange={onChange} suggestions={pool} />
  );
}
