import { useEffect, useState } from "react";
import { detectHarnesses } from "../../../lib/bridge";
import { HarnessPicker } from "../../../components/HarnessPicker";
import "../../../components/formFields.css";

export function CodingAgentStep({
  selected,
  onSelect,
}: {
  selected: string | undefined;
  onSelect: (harness: string) => void;
}) {
  const [detected, setDetected] = useState<string[] | undefined>(undefined);

  useEffect(() => {
    // Detection failure = nothing detected; the empty state below already
    // explains how to proceed without one.
    detectHarnesses()
      .then(setDetected)
      .catch(() => setDetected([]));
  }, []);

  if (detected === undefined) {
    return <p className="field-help">Looking for a coding agent on this machine…</p>;
  }

  if (detected.length === 0) {
    return (
      <p>
        No supported coding agent (opencode, Claude Code, Codex, or GitHub Copilot) was found on
        this machine yet. Install one, then come back to this step — you can also finish setup
        now and pick an agent later in Settings.
      </p>
    );
  }

  return <HarnessPicker options={detected} selected={selected} onSelect={onSelect} />;
}
