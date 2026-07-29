import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";

/**
 * A y/n field, rendered like TextField but driven by single keypresses
 * ("y"/"n" set the whole value; there's no free-typed text to edit) —
 * OnboardingWizard.tsx owns that key handling and just hands this the
 * resulting draft value ("" | "Yes" | "No").
 */
export function YesNoTextField({
  label,
  value,
  focused,
}: {
  label: string;
  value: string;
  focused: boolean;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={focused ? theme.accent : undefined} bold={focused} wrap="truncate-end">
        {focused ? "> " : "  "}
        {label}
      </Text>
      <Box paddingLeft={2}>
        {value ? (
          <Text bold color={value === "Yes" ? theme.good : theme.warn} wrap="truncate-end">
            {value}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {focused ? "y/n" : "(not set)"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
