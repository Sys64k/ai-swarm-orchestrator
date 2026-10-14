"use client";

import { useState } from "react";

/** Token field for phones: no auto-capitalisation or autocorrect, and a Show toggle to check it. */
export function TokenInput() {
  const [visible, setVisible] = useState(false);
  return (
    <div className="token-input">
      <input
        className="input"
        type={visible ? "text" : "password"}
        name="token"
        autoComplete="current-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="aso_…"
        required
        autoFocus
      />
      <button type="button" className="token-toggle" onClick={() => setVisible(!visible)}>
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}
