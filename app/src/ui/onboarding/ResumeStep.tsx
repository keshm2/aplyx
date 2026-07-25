import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";
import { ResumesScreen } from "../ResumesScreen.js";

/**
 * Thin wrapper around the existing resume list + convert-with-
 * description flow (Phase 4) — not one of the 18 counted fields, so it
 * gets its own page after "Job targets" instead of a slot in the
 * percentage bar. ResumesScreen already owns its full keyboard/state
 * story; this just adds the onboarding-appropriate framing around it
 * and forwards onInputActiveChange so OnboardingWizard.tsx can gate its
 * own Shift+←/→ page-nav handler while the description prompt is open.
 */
export function ResumeStep({
  root,
  active,
  onInputActiveChange,
  contentRows,
}: {
  root: string;
  active: boolean;
  onInputActiveChange: (active: boolean) => void;
  contentRows: number;
}) {
  return (
    <Box flexDirection="column">
      <Text color={theme.warn} wrap="wrap">
        ⚠ Optional — nothing here is required to finish setup.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text wrap="wrap">
          Press <Text bold color={theme.accent}>o</Text> to open this folder now and drop your resume file(s) in, or
          press <Text bold color={theme.accent}>esc</Text> (or <Text bold color={theme.accent}>PgDn</Text>) to skip
          for now — you can add resumes any time later from the Resumes tab.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color={theme.accent}>
          Resumes
        </Text>
      </Box>
      <Box marginTop={1}>
        <ResumesScreen
          root={root}
          active={active}
          onInputActiveChange={onInputActiveChange}
          contentRows={Math.max(6, contentRows - 4)}
        />
      </Box>
    </Box>
  );
}
