import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";
import { PRIVACY_LINE } from "@aplyx/core/onboarding/fields.js";

/**
 * Shared chrome for a page: the persistent privacy line, the page
 * title, and the fields stacked vertically below (passed as children).
 * Progress no longer renders here — it lives in the sidebar
 * (OnboardingSidePanel), not inline in the page frame.
 */
export function QuestionFrame({
  title,
  children,
  alert,
}: {
  title: string;
  children: React.ReactNode;
  /** Optional hard-stop banner (e.g. "page-forward blocked") rendered in
   *  theme.danger below the privacy line — distinct from and additional
   *  to it, never a replacement, since the two convey different things
   *  (a passive reassurance vs. an active gate). */
  alert?: string;
}) {
  return (
    <Box flexDirection="column">
      <Text color={theme.warn} wrap="wrap">
        ⚠ {PRIVACY_LINE}
      </Text>
      {alert ? (
        <Box marginTop={1}>
          <Text bold color={theme.danger} wrap="wrap">
            ⚠ {alert}
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text bold color={theme.accent}>
          {title}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
