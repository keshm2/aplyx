import { useEffect, useState } from "react";
import { runValidator } from "../../../lib/bridge";
import "../../../components/formFields.css";

type CheckState = "pending" | "ok" | "fail";

export function EnvironmentStep({ root }: { root: string }) {
  const [state, setState] = useState<CheckState>("pending");
  const [output, setOutput] = useState("");

  useEffect(() => {
    let cancelled = false;
    runValidator(root)
      .then((result) => {
        if (cancelled) return;
        setState(result.ok ? "ok" : "fail");
        setOutput(result.output);
      })
      .catch((err) => {
        if (cancelled) return;
        setState("fail");
        setOutput(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  return (
    <div>
      <div className="check-row">
        <span className={`check-icon check-icon-${state === "pending" ? "pending" : state === "ok" ? "ok" : "fail"}`}>
          {state === "pending" ? "…" : state === "ok" ? "✓" : "!"}
        </span>
        <div>
          <div className="check-label">
            {state === "pending"
              ? "Checking your local configuration…"
              : state === "ok"
                ? "Configuration looks good"
                : "A few things need attention"}
          </div>
          {output && <div className="check-detail">{output}</div>}
        </div>
      </div>
      {state === "fail" && (
        <p className="field-help" style={{ marginTop: "0.75rem" }}>
          You can continue anyway — the remaining steps fill in most of what the validator checks.
        </p>
      )}
    </div>
  );
}
