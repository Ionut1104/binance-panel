// Notificări colorate în colț: verde = fill, roșu = eroare, albastru = trimis.
// Feedback instant, fără spinner blocant.
import React from 'react';

export default function Toasts({ toasts }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
          {t.sub && <div className="sub">{t.sub}</div>}
        </div>
      ))}
    </div>
  );
}
