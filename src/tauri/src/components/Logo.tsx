import logoMarkUrl from "../assets/logo-mark.png";
import "./Logo.css";

/**
 * The aplyx mark: the operator-supplied reference badge image, used
 * verbatim (cropped to just the rounded-square badge — the reference's
 * white background and wordmark below it are cropped away, not part of
 * the mark itself). Same source art as the actual macOS app icon
 * (src/assets/logo-mark-icon-source.png, that version composited with the
 * standard icon-canvas margin for `npx tauri icon`) — one image, used
 * everywhere the app shows its logo, including the initial launch/loading
 * screen (App.tsx's RouteLoading and EntryScreen's "checking" state both
 * render this same component).
 */
export function LogoMark({ size = 32 }: { size?: number }) {
  return <img src={logoMarkUrl} width={size} height={size} alt="aplyx" className="logo-mark" />;
}

export function Logo({ size = 32, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="logo-lockup">
      <LogoMark size={size} />
      {withWordmark && <span className="logo-wordmark">aplyx</span>}
    </span>
  );
}
