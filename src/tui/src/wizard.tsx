import React from "react";
import { render } from "ink";
import { runValidator } from "@aplyx/core/helpers.js";
import { withAltScreen } from "./altScreen.js";
import { OnboardingWizard } from "./ui/onboarding/OnboardingWizard.js";

/**
 * Entry point for `aplyx setup [--check]`. The interactive flow is the
 * Ink onboarding wizard (`src/tui/src/ui/onboarding/OnboardingWizard.tsx`) —
 * this file no longer prompts anything itself. `--check`, and any
 * non-TTY context where an Ink app can't take keyboard input (CI, piped
 * output), fall back to a short pointer at the example config's `_help`
 * block and the Settings/Config tab, then just run the validator.
 */

export async function runWizard(root: string, checkOnly: boolean): Promise<number> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (checkOnly || !interactive) {
    if (!checkOnly) {
      console.log(
        "aplyx setup needs an interactive terminal to run the guided wizard.\n" +
          "See src/config/targets.example.json's _help block, or edit src/config/targets.json\n" +
          "and src/config/discord_config.json directly, then run `aplyx setup --check`.\n" +
          "Once aplyx is running, the Settings tab keeps everything editable.\n",
      );
    }
    return report(runValidatorAndPrint(root));
  }

  await withAltScreen(() => {
    let instance: ReturnType<typeof render>;
    instance = render(<OnboardingWizard root={root} onDone={() => instance.unmount()} />);
    return instance;
  });

  return report(runValidatorAndPrint(root));
}

function runValidatorAndPrint(root: string): boolean {
  const { ok, output } = runValidator(root);
  console.log(output);
  return ok;
}

function report(ok: boolean): number {
  console.log(ok ? "\nSetup looks good — config is valid." : "\nConfig is not valid yet — fix the ERROR lines above and re-run `aplyx setup --check`.");
  return ok ? 0 : 1;
}
