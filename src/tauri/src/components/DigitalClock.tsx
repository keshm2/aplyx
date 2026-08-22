import { useEffect, useState } from "react";
import "./DigitalClock.css";

function format(now: Date): { time: string; period: string } {
  let hours = now.getHours();
  const period = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return { time: `${hours}:${minutes}:${seconds}`, period };
}

/** A small live clock — genuinely live content next to the greeting
 *  (ticks every real second), not decoration, and the one deliberately
 *  "different" element on Home: an LCD-style dark chip with glowing
 *  monospace digits, rather than the app's usual card language. No new
 *  font file needed for the digital-clock feel — --font-mono + tabular
 *  spacing + a colored glow reads as one without shipping a 7-segment
 *  typeface. */
export function DigitalClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const { time, period } = format(now);

  return (
    <div className="digital-clock" role="timer" aria-label={`Current time ${time} ${period}`}>
      <span className="digital-clock-time">{time}</span>
      <span className="digital-clock-period">{period}</span>
    </div>
  );
}
