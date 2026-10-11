// Selectorul de simbol: search cu autocomplete + favorite pe tastele 1–9.
import React, { useState, useRef, useEffect } from 'react';

export default function SymbolBar({ symbols, symbol, favorites, onSelect, searchRef }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const boxRef = useRef(null);

  // Filtrare autocomplete: match pe substring, dar sortat după relevanță —
  // altfel căutând "AKEUSDT" primeai CAKEUSDT/TAKEUSDT înaintea lui AKEUSDT
  // (toate trei îl conțin ca substring), iar cel căutat efectiv părea că
  // lipsește dacă rămânea ultimul într-un dropdown scurt. Simbolurile care
  // ÎNCEP cu ce cauți vin primele, apoi restul, cele mai scurte primele.
  const matches = query
    ? (() => {
        const q = query.toUpperCase();
        return symbols
          .filter((s) => s.includes(q))
          .sort((a, b) => {
            const aStarts = a.startsWith(q) ? 0 : 1;
            const bStarts = b.startsWith(q) ? 0 : 1;
            return aStarts - bStarts || a.length - b.length;
          })
          .slice(0, 30);
      })()
    : [];

  useEffect(() => { setSel(0); }, [query]);

  // Închide dropdown-ul la click în afara lui.
  useEffect(() => {
    const h = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const pick = (s) => {
    onSelect(s);
    setQuery('');
    setOpen(false);
    searchRef.current?.blur(); // ieșim din input ca hotkey-urile să redevină active
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter' && matches[sel]) pick(matches[sel]);
    else if (e.key === 'Escape') { setQuery(''); setOpen(false); searchRef.current?.blur(); }
  };

  return (
    <>
      <div className="symsearch" ref={boxRef}>
        <input
          ref={searchRef}
          placeholder={symbol || 'Caută simbol…'}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
        />
        {open && matches.length > 0 && (
          <div className="sugg">
            {matches.map((s, i) => (
              <div key={s} className={i === sel ? 'sel' : ''}
                   onMouseDown={() => pick(s)}>{s}</div>
            ))}
          </div>
        )}
      </div>
      <div className="fav">
        {favorites.slice(0, 9).map((f, i) => (
          <button key={f} className={f === symbol ? 'active' : ''} onClick={() => onSelect(f)}
                  title={`Tasta ${i + 1}`}>
            <span className="num">{i + 1}</span>{f.replace('USDT', '')}
          </button>
        ))}
      </div>
    </>
  );
}
