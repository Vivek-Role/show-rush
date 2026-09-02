import { useState } from 'react';

// Poster art, with a placeholder that looks deliberate.
//
// The seeded catalogue carries no poster_url, and a real one can always 404, so
// both cases land on the same fallback: the film's initials on a gradient. It
// is decorative either way — the title is right beside it in the markup, so the
// image is aria-hidden rather than repeating the name to a screen reader.
function initialsOf(title) {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

export function Poster({ movie }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(movie.poster_url) && !failed;

  return (
    <div className="poster">
      {showImage ? (
        <img src={movie.poster_url} alt="" onError={() => setFailed(true)} />
      ) : (
        <span className="poster__initials" aria-hidden="true">
          {initialsOf(movie.title)}
        </span>
      )}

      {movie.certificate ? <span className="poster__cert">{movie.certificate}</span> : null}
    </div>
  );
}
