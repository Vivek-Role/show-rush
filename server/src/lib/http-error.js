// Every non-2xx response under /api is { error: { code, message } }. The code
// is the stable part: clients branch on it, the message is for humans.
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
