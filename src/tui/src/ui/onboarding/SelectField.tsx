import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";
import type { SelectOption } from "@aplyx/core/onboarding/fields.js";

/**
 * An arbitrary-length fixed-choice field (citizenship, gender), same
 * split as Select3TextField: OnboardingWizard.tsx owns the number-key
 * handling and hands this the machine value the user has picked so far
 * ("" until they choose). Purely presentational.
 */
export function SelectField({
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
  const chosen = options.find((o) => o.value === value);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={focused ? theme.accent : undefined} bold={focused} wrap="truncate-end">
        {focused ? "> " : "  "}
        {label}
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        {chosen ? (
          <Text bold color={theme.accent} wrap="truncate-end">
            {chosen.label}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            (not set)
          </Text>
        )}
        {focused
          ? options.map((opt, i) => (
              <Text key={opt.value} color={opt.value === value ? theme.accent : undefined} dimColor={opt.value !== value} wrap="truncate-end">
                {`  ${i + 1} `}
                {opt.label}
              </Text>
            ))
          : null}
        {focused && value ? (
          <Text dimColor wrap="truncate-end">
            backspace clears
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
