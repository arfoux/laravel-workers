// kernel/validation.mjs — ValidationException + the session error-bag shape.
//
// Mirrors the parts of Laravel the compiled rung needs to turn a failed
// `$request->validate()` into the same redirect a real app produces:
//   - Illuminate\Validation\ValidationException (status 422, errorBag, redirectTo,
//     summarize() message)
//   - Illuminate\Foundation\Exceptions\Handler::dontFlash (inputs never flashed back)
//   - Illuminate\Http\RedirectResponse::withErrors()/withInput() ->
//     session flash 'errors' + '_old_input'
//   - Illuminate\Session\Store::prepareErrorBagForSerialization() (json sessions
//     store the error bag as { bag: { format, messages } })
//
// The actual rule engine is kernel/validator.mjs. This module only owns the
// exception surface and the on-disk bag shape.
import { validate as runValidator } from './validator.mjs';

// Illuminate\Foundation\Exceptions\Handler::$dontFlash (13.x default).
export const DEFAULT_DONT_FLASH = ['current_password', 'password', 'password_confirmation'];

// Illuminate\Support\MessageBag default format.
export const MESSAGE_BAG_FORMAT = ':message';

// Illuminate\Validation\ValidationException::summarize() — first message plus
// "(and N more error(s))".
export function summarizeValidation(errors) {
  const all = [];
  for (const field of Object.keys(errors || {})) {
    for (const m of errors[field]) all.push(m);
  }
  if (all.length === 0) return 'The given data was invalid.';
  const message = all.shift();
  const count = all.length;
  return count ? `${message} (and ${count} more error${count === 1 ? '' : 's'})` : message;
}

export class ValidationException extends Error {
  /**
   * @param {object} errors      { field: [messages] } (validator->errors())
   * @param {object} [opts]      { errorBag = 'default', redirectTo = null, status = 422 }
   */
  constructor(errors, opts = {}) {
    super(summarizeValidation(errors));
    this.name = 'ValidationException';
    this.validationErrors = errors;
    this.status = opts.status ?? 422;
    this.errorBag = opts.errorBag ?? 'default';
    this.redirectTo = opts.redirectTo ?? null;
    // Compiled controllers rethrow this marker so the HTTP kernel renders it
    // (redirect + flash) instead of rt.errorResponse() flattening it to a body.
    this.lwKernel = true;
  }

  /** ValidationException::errors() — { field: [messages] }. */
  errors() {
    return this.validationErrors;
  }
}

/**
 * Illuminate\Validation\ValidationException::withMessages() — build an exception
 * straight from a `{ field: message | [messages] }` map. Mirrors the vendor
 * implementation: `Arr::wrap()` each value and append through MessageBag::add()
 * (which skips duplicates), so `summarize()`/the flashed bag match byte-for-byte.
 */
export function validationExceptionWithMessages(messages, opts = {}) {
  const errors = {};
  for (const key of Object.keys(messages || {})) {
    const value = messages[key];
    const list = Array.isArray(value) ? value : [value];
    for (const message of list) {
      const bucket = errors[key] || (errors[key] = []);
      if (!bucket.includes(message)) bucket.push(message);
    }
  }
  return new ValidationException(errors, opts);
}

/**
 * Attach `validate()` / `validateWithBag()` to a compiled request object
 * (Illuminate\Http\Request::validate / validateWithBag, via ValidatesRequests).
 *
 * @param {object} request   the kernel request object (request.all() is the data)
 * @param {object} [opts]    { db } — passed to the rule engine for unique/exists
 */
export function installValidation(request, opts = {}) {
  const run = async (rules, messages = {}, attributes = {}, errorBag = 'default') => {
    const { ok, errors, validated } = await runValidator(request.all(), rules, messages, {
      db: opts.db ?? null,
      attributes,
    });
    if (!ok) throw new ValidationException(errors, { errorBag });
    request._validatedData = validated;
    return validated;
  };

  request.validate = (rules, messages, attributes) => run(rules, messages, attributes);
  request.validateWithBag = (bag, rules, messages, attributes) =>
    run(rules, messages, attributes, bag);
  request.validated = () => (request._validatedData ? request._validatedData : {});
  return request;
}

/**
 * Illuminate\Http\RedirectResponse::withErrors() session value, in the shape
 * Illuminate\Session\Store::prepareErrorBagForSerialization() writes for json
 * sessions: `{ [bag]: { format: ':message', messages: { field: [msg] } } }`.
 */
export function sessionErrorBag(bag, messages) {
  return { [bag]: { format: MESSAGE_BAG_FORMAT, messages } };
}

export default {
  ValidationException,
  validationExceptionWithMessages,
  installValidation,
  summarizeValidation,
  sessionErrorBag,
  DEFAULT_DONT_FLASH,
  MESSAGE_BAG_FORMAT,
};
