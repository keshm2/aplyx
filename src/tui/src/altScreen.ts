import type { render } from "ink";

type Instance = ReturnType<typeof render>;

/** Alternate screen: full-screen Ink app without scrollback pollution, and
 * the terminal restored on any exit path (quit, error, Ctrl-C). Shared by
 * every full-screen render (`<App>`, `<OnboardingWizard>`) so the escape-
 * sequence pair and resize handling live in exactly one place. */
export async function withAltScreen(renderFn: () => Instance): Promise<void> {
  const enter = "\x1b[?1049h\x1b[H";
  const leave = "\x1b[?1049l";
  process.stdout.write(enter);
  const restore = () => process.stdout.write(leave);
  process.on("exit", restore);
  try {
    const instance = renderFn();
    // On resize, Ink diffs against the frame it drew for the OLD terminal
    // size, leaving artifacts (stale rows on shrink, misaligned lines on
    // reflow). Clearing Ink's frame forces a clean full repaint at the new
    // size; the mounted component's own resize listener re-derives layout.
    //
    // Debounced: a single user resize can fire many 'resize' events in a
    // row (observed on Windows Terminal, whose maximize/snap animation
    // reports several intermediate sizes rather than one final one) — each
    // one triggering an immediate full-screen clear stacked back-to-back
    // reads as visible flicker, worst at the bottom rows since those paint
    // last in every one of the redraws. Waiting for the burst to settle
    // collapses it into a single clear+repaint.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => instance.clear(), 80);
    };
    process.stdout.on("resize", onResize);
    try {
      await instance.waitUntilExit();
    } finally {
      process.stdout.off("resize", onResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    }
  } finally {
    process.off("exit", restore);
    restore();
  }
}
