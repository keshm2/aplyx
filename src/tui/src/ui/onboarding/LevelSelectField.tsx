import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";
import { LEVEL_CATEGORIES } from "@aplyx/core/data/levelCategories.js";

/**
 * The onboarding "what are you looking for?" field: a fixed checkbox list
 * over LEVEL_CATEGORIES (Intern / New grad / Entry-level / Full time),
 * driven by single number keys (1-4 toggle that row). Purely
 * presentational, same split as Select3TextField: OnboardingWizard.tsx
 * owns the key handling and hands this the set of checked category ids.
 */
export function LevelSelectField({
  label,
  selected,
  focused,
}: {
  label: string;
  selected: Set<string>;
  focused: boolean;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={focused ? theme.accent : undefined} bold={focused} wrap="truncate-end">
        {focused ? "> " : "  "}
        {label}
      </Text>
      <Box paddingLeft={2} flexDirection="column">
        {LEVEL_CATEGORIES.map((cat, i) => {
          const on = selected.has(cat.id);
          return (
            <Text key={cat.id} color={on ? theme.accent : undefined} dimColor={!on && !focused} wrap="truncate-end">
              {focused ? `${i + 1} ` : "  "}
              [{on ? "x" : " "}] {cat.label}
              {cat.experienceHint ? ` (${cat.experienceHint})` : ""}
            </Text>
          );
        })}
        {selected.size === 0 ? (
          <Text color={theme.warn} wrap="truncate-end">
            pick at least one
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
