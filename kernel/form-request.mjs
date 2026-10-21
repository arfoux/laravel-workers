// kernel/form-request.mjs — the FormRequest base (Laravel's
// Illuminate\Foundation\Http\FormRequest).
//
// The compiled FormRequest extends this: the class compiler emits the app's
// own methods (the hooks Laravel runs on the request - `prepareForValidation()`)
// and this base provides the request surface those hooks use: the input bag the
// hook writes into (`merge()`) and the data the validation reads.
//
// Laravel's FormRequest IS a request (it extends Illuminate\Http\Request), so
// the base holds the request the runtime built and forwards to it. The
// semantics are Laravel's: `merge()` puts the input into the request's INPUT
// SOURCE and every key REPLACES the value (it is not a deep merge), the dot
// notation is honoured (Arr::set) - see kernel/http.mjs.
export class FormRequest {
  constructor(request) {
    // The request the runtime built (the input bag the hooks write into).
    this.__request = request || null;
  }

  // Illuminate\Http\Request::merge().
  merge(input) {
    if (this.__request && typeof this.__request.merge === 'function') {
      this.__request.merge(input);
    }
    return this;
  }

  // Illuminate\Http\Request::all() / input().
  all() {
    return this.__request ? this.__request.all() : {};
  }

  input(key = null, def = null) {
    if (!this.__request) return def;
    return this.__request.input(key, def);
  }
}

export default { FormRequest };
