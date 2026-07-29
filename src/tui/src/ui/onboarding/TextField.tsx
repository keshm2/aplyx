import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";
import { InlineTextInput } from "../TextInput.js";

/**
 * A single text field's label + input, meant to be stacked several-to-a-
 * page inside QuestionFrame. Reused as-is for the roles field (a
 * comma-separated text box) — its skip-defaults warning is just an
 * optional line below the input, same shape as MultiEntryAutocomplete's.
 */
export function TextField({
  label,
  value,
  cursor,
  focused,
  placeholder,
  warning,
  help,
}: {
  label: string;
  value: string;
  cursor: number;
  focused: boolean;
  placeholder?: string;
  warning?: string;
  /** Explanatory line under the label — only rendered while focused, so
   *  an unfocused stack of fields stays scannable. */
  help?: string;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={focused ? theme.accent : undefined} bold={focused} wrap="truncate-end">
        {focused ? "> " : "  "}
        {label}
      </Text>
      {focused && help ? (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">
            {help}
          </Text>
        </Box>
      ) : null}
      <Box paddingLeft={2}>
        <InlineTextInput value={value} cursor={cursor} active={focused} placeholder={placeholder} wrap="truncate-end" />
      </Box>
      {warning ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text color={theme.warn} wrap="wrap">
            ⚠ {warning}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
