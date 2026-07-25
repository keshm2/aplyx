import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

/**
 * Blocks Automatic run mode until at least one resume and one coding
 * agent are both in place — a run with neither has nothing to tailor
 * from and nothing to drive the browser/apply steps, so it would just
 * fail immediately (or worse, half-succeed in a confusing way). Shown
 * in place of RunScreen by App.tsx whenever the Jobs tab is in
 * automatic mode and either check fails.
 *
 * Both checks are cheap, uncached filesystem/PATH probes (see
 * @aplyx/core/resumes.js's listResumeFiles and @aplyx/core/harness.js's
 * detectHarnessOnPath) re-run fresh on every render — installing a
 * coding agent or adding a resume while the TUI is still open, then
 * switching tabs (which already triggers App's refresh()) or pressing
 * `m` to toggle back and forth, clears the gate with no restart needed.
 */
export function AutomaticModeGate({
  missingResume,
  missingHarness,
  contentRows,
}: {
  missingResume: boolean;
  missingHarness: boolean;
  contentRows: number;
}) {
  const tight = contentRows < 14;
  return (
    <Box flexDirection="column">
      <Text bold color={theme.danger}>
        ⚠ Automatic run needs a bit more setup first
      </Text>
      <Box marginTop={1}>
        <Text wrap="wrap">
          Automatic runs tailor a resume and drive a coding agent through the
          apply flow — with neither in place there's nothing for it to work
          from. Recommended: have at least one of each before running
          automatically. Until then, this mode stays blocked (Manual search
          still works fine — press m to switch back).
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color={missingResume ? theme.danger : theme.good}>
            {missingResume ? "✗" : "✓"}
          </Text>
          <Text> at least one resume in data/resumes/ </Text>
          <Text dimColor>{missingResume ? "— missing" : "— found"}</Text>
        </Text>
        <Text>
          <Text color={missingHarness ? theme.danger : theme.good}>
            {missingHarness ? "✗" : "✓"}
          </Text>
          <Text> a coding agent on PATH </Text>
          <Text dimColor>{missingHarness ? "— none detected" : "— found"}</Text>
        </Text>
      </Box>
      {!tight ? (
        <Box marginTop={1} flexDirection="column">
          {missingResume ? (
            <Text dimColor wrap="wrap">
              6 Resumes — see what aplyx expects and how to add one (PDF or
              markdown; PDFs convert in place).
            </Text>
          ) : null}
          {missingHarness ? (
            <Text dimColor wrap="wrap">
              Install opencode, Claude Code, Codex CLI, or GitHub Copilot CLI,
              then come back — no restart needed, this re-checks every time
              you switch tabs or press R.
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
