import React from "react";
import { Text } from "ink";
import { theme } from "../theme.js";

export interface InlineInputState {
  value: string;
  cursor: number;
}

function clampCursor(value: string, cursor: number): number {
  return Math.max(0, Math.min(value.length, cursor));
}

export function moveCursorLeft(state: InlineInputState): InlineInputState {
  return { ...state, cursor: clampCursor(state.value, state.cursor - 1) };
}

export function moveCursorRight(state: InlineInputState): InlineInputState {
  return { ...state, cursor: clampCursor(state.value, state.cursor + 1) };
}

export function insertAtCursor(
  state: InlineInputState,
  input: string,
  options: { maxLength?: number; sanitize?: (value: string) => string } = {},
): InlineInputState {
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  const sanitize = options.sanitize ?? ((value: string) => value);
  const cursor = clampCursor(state.value, state.cursor);
  const insert = sanitize(input);
  if (!insert) return state;

  const before = state.value.slice(0, cursor);
  const after = state.value.slice(cursor);
  const room = Math.max(0, maxLength - before.length - after.length);
  const chunk = insert.slice(0, room);
  if (!chunk) return state;

  return {
    value: before + chunk + after,
    cursor: cursor + chunk.length,
  };
}

export function deleteBackward(state: InlineInputState): InlineInputState {
  const cursor = clampCursor(state.value, state.cursor);
  if (cursor === 0) return state;
  return {
    value: state.value.slice(0, cursor - 1) + state.value.slice(cursor),
    cursor: cursor - 1,
  };
}

export function deleteForward(state: InlineInputState): InlineInputState {
  const cursor = clampCursor(state.value, state.cursor);
  if (cursor >= state.value.length) return state;
  return {
    value: state.value.slice(0, cursor) + state.value.slice(cursor + 1),
    cursor,
  };
}

export function InlineTextInput({
  value,
  cursor,
  active,
  placeholder,
  wrap,
}: {
  value: string;
  cursor: number;
  active: boolean;
  placeholder?: string;
  wrap?: "truncate" | "truncate-start" | "truncate-middle" | "truncate-end" | "wrap";
}) {
  const safeCursor = clampCursor(value, cursor);

  if (!active) {
    if (!value) {
      return (
        <Text dimColor wrap={wrap}>
          {placeholder ?? ""}
        </Text>
      );
    }
    return <Text wrap={wrap}>{value}</Text>;
  }

  if (!value) {
    return (
      <Text wrap={wrap}>
        <Text color={theme.accent}>▏</Text>
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </Text>
    );
  }

  const before = value.slice(0, safeCursor);
  const current = value[safeCursor];
  const after = value.slice(current ? safeCursor + 1 : safeCursor);

  return (
    <Text wrap={wrap}>
      {before}
      {current ? (
        <Text inverse color={theme.accent}>
          {current}
        </Text>
      ) : (
        <Text color={theme.accent}>▏</Text>
      )}
      {after}
    </Text>
  );
}
