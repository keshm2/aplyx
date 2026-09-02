import React from "react";
import { Box, Text } from "ink";
import { theme } from "../../theme.js";
import { buildMonthGrid, CALENDAR_MIN_YEAR } from "./dateCalendar.js";

const WEEKDAY_HEADER = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Terminal calendar overlay for the date-of-birth field: an arrow-key-
 * navigable month grid, the keyboard equivalent of the desktop app's
 * mouse-driven calendar popover (DatePickerField.tsx). OnboardingWizard.tsx
 * owns all key handling (see dateCalendar.ts for the move/clamp math) and
 * passes down the date the cursor is currently on; this is pure rendering.
 */
export function DateCalendarField({ cursor }: { cursor: Date }) {
  const grid = buildMonthGrid(cursor);
  const year = cursor.getFullYear();

  return (
    <Box flexDirection="column" paddingLeft={2} marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color={theme.accent}>
          {MONTH_NAMES[cursor.getMonth()]} {year}
        </Text>
      </Box>
      <Box>
        {WEEKDAY_HEADER.map((w) => (
          <Box key={w} width={4}>
            <Text dimColor> {w}</Text>
          </Box>
        ))}
      </Box>
      {grid.map((week, ri) => (
        <Box key={ri}>
          {week.map((cell, ci) => {
            if (cell.day === null) {
              return (
                <Box key={ci} width={4}>
                  <Text>{"    "}</Text>
                </Box>
              );
            }
            const dd = String(cell.day).padStart(2, "0");
            return (
              <Box key={ci} width={4}>
                {cell.isSelected ? (
                  <Text bold color={theme.accent}>
                    [{dd}]
                  </Text>
                ) : (
                  <Text color={cell.isToday ? theme.accent : undefined} dimColor={!cell.isToday}>
                    {" "}
                    {dd}{" "}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          ←→ day · ↑↓ week · PgUp/PgDn month · [ ] year ({CALENDAR_MIN_YEAR}–{new Date().getFullYear()}) · enter select · esc cancel
        </Text>
      </Box>
    </Box>
  );
}
