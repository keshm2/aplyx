import { openExtensionFolder } from "../../../lib/bridge";

export function ExtensionStep({ root }: { root: string }) {
  return (
    <div>
      <p>
        The browser extension lets aplyx fill out application forms it can&rsquo;t reach through a
        job board&rsquo;s API. It&rsquo;s optional — everything else works without it — and installs like
        any unpacked browser extension.
      </p>
      <button
        type="button"
        className="wizard-back"
        style={{ marginTop: "0.75rem" }}
        onClick={() => openExtensionFolder(root)}
      >
        Open extension folder
      </button>
    </div>
  );
}
