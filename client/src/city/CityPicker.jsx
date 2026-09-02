import { useEffect, useRef, useState } from 'react';
import { useCity } from './CityContext.jsx';

// The location control every booking site puts in its header: current city,
// click to change, search to find one.
//
// A dialog rather than a dropdown, because a city list is a search problem once
// it is longer than a screen — and because a dialog is the shape that survives
// the list growing. Escape closes it, focus moves into the search box on open
// and back to the trigger on close, and the backdrop is clickable.
export function CityPicker() {
  const { city, setCity, cities } = useCity();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const triggerRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    searchRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
    // Focus must come back to where it left, or a keyboard user is dropped at
    // the top of the document.
    triggerRef.current?.focus();
  }

  function choose(name) {
    setCity(name);
    close();
  }

  const needle = query.trim().toLowerCase();
  const matches = cities.filter((candidate) => candidate.name.toLowerCase().includes(needle));

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="btn btn--onDark btn--sm city-trigger"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span aria-hidden="true">📍</span>
        <span className="city-trigger__name">{city}</span>
      </button>

      {open ? (
        <div className="modal" role="presentation" onClick={close}>
          <div
            className="modal__panel card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="city-dialog-title"
            // The backdrop closes the dialog; a click inside it must not.
            onClick={(event) => event.stopPropagation()}
          >
            <div className="card__body">
              <div className="modal__head">
                <h2 id="city-dialog-title">Choose your city</h2>
                <button type="button" className="btn btn--sm" onClick={close}>
                  Close
                </button>
              </div>

              <label className="field" style={{ marginTop: '0.85rem' }}>
                <span className="field__label">Search city</span>
                <input
                  ref={searchRef}
                  className="field__input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Start typing…"
                  autoComplete="off"
                />
              </label>

              {matches.length === 0 ? (
                <p className="empty" style={{ padding: '1.25rem 0' }}>
                  No city matches “{query}”.
                </p>
              ) : (
                <ul className="city-list">
                  {matches.map((candidate) => (
                    <li key={candidate.name}>
                      <button
                        type="button"
                        className="city-list__item"
                        onClick={() => choose(candidate.name)}
                        aria-current={candidate.name === city ? 'true' : undefined}
                      >
                        <span>{candidate.name}</span>
                        {candidate.name === city ? (
                          <span className="chip">Selected</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Said plainly rather than discovered by a visitor who picks a
                  city and finds an empty page. */}
              <p className="note note--info" style={{ marginTop: '0.85rem' }}>
                This build ships one cinema, in Bengaluru. More cities appear here once the
                catalogue carries venues in them.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
