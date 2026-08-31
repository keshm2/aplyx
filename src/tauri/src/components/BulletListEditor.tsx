import type { MasterResumeBullet } from "@aplyx/core/masterResume.js";
import "./BulletListEditor.css";

/** Shared add/edit/delete/reorder UI for a bullet list: Experience and
 *  Project entries on the Resumes screen both need identical bullet
 *  editing, so this is factored once rather than duplicated per section.
 *  Fully controlled: the parent holds the bullets array and gets a new
 *  array back on every change, same pattern as ProfileScreen.tsx's field
 *  editing (load all, edit in memory, Save writes everything). */
export function BulletListEditor({
  bullets,
  onChange,
  placeholder = "Describe an accomplishment: start with an action verb, include a metric if you can",
}: {
  bullets: MasterResumeBullet[];
  onChange: (bullets: MasterResumeBullet[]) => void;
  placeholder?: string;
}) {
  const updateBullet = (id: string, text: string) => {
    onChange(bullets.map((b) => (b.id === id ? { ...b, text } : b)));
  };

  const deleteBullet = (id: string) => {
    onChange(bullets.filter((b) => b.id !== id));
  };

  const addBullet = () => {
    onChange([...bullets, { id: crypto.randomUUID(), text: "" }]);
  };

  const moveBullet = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= bullets.length) return;
    const next = [...bullets];
    const a = next[index]!;
    const b = next[target]!;
    next[index] = b;
    next[target] = a;
    onChange(next);
  };

  return (
    <div className="bullet-list-editor">
      {bullets.map((bullet, i) => (
        <div key={bullet.id} className="bullet-list-row">
          <div className="bullet-list-reorder">
            <button
              type="button"
              className="bullet-list-move"
              disabled={i === 0}
              onClick={() => moveBullet(i, -1)}
              aria-label="Move bullet up"
              title="Move up"
            >
              ↑
            </button>
            <button
              type="button"
              className="bullet-list-move"
              disabled={i === bullets.length - 1}
              onClick={() => moveBullet(i, 1)}
              aria-label="Move bullet down"
              title="Move down"
            >
              ↓
            </button>
          </div>
          <textarea
            className="bullet-list-textarea"
            value={bullet.text}
            onChange={(e) => updateBullet(bullet.id, e.currentTarget.value)}
            rows={2}
            placeholder={placeholder}
          />
          <button
            type="button"
            className="bullet-list-delete"
            onClick={() => deleteBullet(bullet.id)}
            aria-label="Delete bullet"
            title="Delete bullet"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm bullet-list-add" onClick={addBullet}>
        + Add bullet
      </button>
    </div>
  );
}
