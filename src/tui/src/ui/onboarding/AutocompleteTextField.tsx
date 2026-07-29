import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";
import { InlineTextInput } from "../TextInput.js";

/**
 * Single-select field with live suggestions (home location). Reuses the
 * focused-row list convention from WelcomeScreen.tsx/SearchScreen.tsx
 * (`>`/`[x]` marker, theme.accent on focus) for the suggestion list.
 * Freehand text with no match is still accepted on Enter — handled by
 * the caller (OnboardingWizard.tsx), not this component.
 */
export function AutocompleteTextField({
  label,
  query,
  cursor,
  focused,
  suggestions,
  suggestionIndex,
  placeholder,
  help,
}: {
  label: string;
  query: string;
  cursor: number;
  focused: boolean;
  suggestions: string[];
  suggestionIndex: number;
  placeholder?: string;
  /** Explanatory line under the label, shown only while focused. */
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
        <InlineTextInput value={query} cursor={cursor} active={focused} placeholder={placeholder} wrap="truncate-end" />
      </Box>
      {focused && suggestions.length > 0 ? (
        <Box paddingLeft={2} flexDirection="column">
          {suggestions.map((s, i) => {
            const hit = i === suggestionIndex;
            return (
              <Text key={s} color={hit ? theme.accent : undefined} bold={hit} wrap="truncate-end">
                {hit ? " >" : "  "} [{hit ? "x" : " "}] {s}
              </Text>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
}
