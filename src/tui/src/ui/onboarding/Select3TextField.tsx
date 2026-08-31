import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";
import type { SelectOption } from "@aplyx/core/onboarding/fields.js";

/**
 * A fixed-three-choice field, same shape as YesNoTextField but generalized
 * from y/n to three labeled options, driven by single keypresses ("1"/
 * "2"/"3" set the whole value; there's no free-typed text to edit).
 * OnboardingWizard.tsx owns that key handling and just hands this the
 * resulting draft label ("" | options[0].label | options[1].label |
 * options[2].label).
 */
export function Select3TextField({
  label,
  value,
  focused,
  options,
}: {
  label: string;
  value: string;
  focused: boolean;
  options: readonly SelectOption[];
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={focused ? theme.accent : undefined} bold={focused} wrap="truncate-end">
        {focused ? "> " : "  "}
        {label}
      </Text>
      <Box paddingLeft={2}>
        {value ? (
          <Text bold color={theme.accent} wrap="truncate-end">
            {value}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {focused ? options.map((opt, i) => `${i + 1}=${opt.label}`).join("  ") : "(not set)"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
