import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";

function Key({ k, desc }: { k: string; desc: string }) {
  return (
    <Box>
      <Box width={16}>
        <Text bold color={theme.accent}>
          {k}
        </Text>
      </Box>
      <Text>{desc}</Text>
    </Box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

/** One dense line per screen — used when the terminal is too short for
 *  the sectioned reference (an overflowing frame corrupts Ink's repaint). */
function CompactHelp() {
  const lines: Array<[string, string]> = [
    ["Everywhere", "1-8/←→/tab screens · esc/w menu · m mode · R reload · q quit"],
    ["Jobs MANUAL", "/ query · ↑↓ select · enter/o open · f fit · s save"],
    ["Jobs AUTO", "e cap (25=MAX) · p prompt · s start"],
    ["Review", "↑↓ · enter/o open · a applied · d dismiss · x resolved"],
    ["Documents", "↑↓ · enter/o open · x resolved (view-only)"],
    ["Letters", "↑↓ · e write · g draft it for me · a approve · d discard"],
    ["History", "↑↓ · enter/o open"],
    ["Resumes", "↑↓ · o open folder · c convert PDF"],
    ["Config", "↑↓ · enter open/edit/toggle · esc back"],
  ];
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Keyboard reference
      </Text>
      {lines.map(([section, keys]) => (
        <Box key={section}>
          <Box width={13}>
            <Text bold>{section}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{keys}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** Full key reference, opened with `?` from anywhere in the app.
 *  Needs ~52 rows (raised 36 -> 52 when the Documents and Letters sections
 *  landed); shorter terminals get the compact variant. */
export function HelpOverlay({ contentRows = 40 }: { contentRows?: number }) {
  if (contentRows < 52) return <CompactHelp />;
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        Keyboard reference
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Section title="Everywhere">
          <Key k="1-8 / tab / ←→" desc="switch screen (Status · Jobs · Review · Documents · Letters · History · Resumes · Config)" />
          <Key k="m" desc="toggle MANUAL / AUTO mode (changes the Jobs screen)" />
          <Key k="R" desc="reload state from disk" />
          <Key k="esc / w" desc="back to the welcome menu (esc never quits; locked mid-run)" />
          <Key k="?" desc="open / close this help" />
          <Key k="q" desc="quit (asks to confirm while a run is active)" />
        </Section>
        <Section title="Jobs — MANUAL (live search)">
          <Key k="/" desc="edit the query · enter runs the search · esc stops typing" />
          <Key k="↑↓ or j/k" desc="select a posting" />
          <Key k="enter / o" desc="open the selected posting in your browser" />
          <Key k="f" desc="run the deterministic fit gate on the selection" />
          <Key k="s" desc="save the selection to the review queue" />
        </Section>
        <Section title="Jobs — AUTO (agent run)">
          <Key k="e" desc="set this cycle's application cap (1–25; colored by cost, 25 = MAX warns)" />
          <Key k="p" desc="optional extra prompt for the agent (empty = standard workflow)" />
          <Key k="s" desc="start the run (streams the session log)" />
        </Section>
        <Section title="Review queue">
          <Key k="enter / o" desc="open the posting" />
          <Key k="a" desc="record as applied (writes through the helpers)" />
          <Key k="d" desc="dismiss (records skipped_unfit)" />
          <Key k="x" desc="show / hide resolved items" />
        </Section>
        <Section title="Documents (view-only)">
          <Key k="↑↓ or j/k" desc="select a queued posting" />
          <Key k="enter / o" desc="open the posting" />
          <Key k="x" desc="show / hide resolved items" />
        </Section>
        <Section title="Interest letters">
          <Key k="↑↓ or j/k" desc="select a parked question" />
          <Key k="e" desc="write your own answer" />
          <Key k="g" desc="have aplyx draft one for you to edit" />
          <Key k="a" desc="approve (lets the next run apply)" />
          <Key k="d" desc="discard" />
        </Section>
        <Section title="History">
          <Key k="enter / o" desc="open the posting" />
        </Section>
        <Section title="Resumes">
          <Key k="↑↓ or j/k" desc="select a resume category" />
          <Key k="o" desc="open data/resumes/ in Finder / Explorer / file manager" />
          <Key k="c / enter" desc="convert the selected PDF to markdown (skips if already converted)" />
        </Section>
        <Section title="Config (settings)">
          <Key k="enter" desc="open a section / edit the selected field (current values always shown)" />
          <Key k="esc" desc="back out of a section, or cancel an edit" />
        </Section>
      </Box>
    </Box>
  );
}
