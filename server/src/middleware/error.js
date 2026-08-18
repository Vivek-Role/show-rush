import { HttpError } from '../lib/http-error.js';

// Express 5 has no wildcard route to attach this to — path-to-regexp v8 no
// longer accepts '*' — so it runs as the last ordinary middleware instead.
export function notFound(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    },
  });
}

// Express 5 forwards rejected async handlers here automatically, so route
// handlers need no try/catch wrapper.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }

  // express.json() rejects malformed bodies before any handler sees them.
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    });
    return;
  }

  // Anything unrecognised is a bug. Log it in full, tell the client nothing —
  // internal messages leak topology.
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
}
