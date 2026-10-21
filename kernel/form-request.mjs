// kernel/form-request.mjs — the FormRequest base (Laravel's
// Illuminate\Foundation\Http\FormRequest).
//
// The compiled FormRequest extends this: the class compiler emits the app's
// own methods (the hooks Laravel runs on the request - `prepareForValidation()`,
// `withValidator()`, `after()`, `passedValidation()`) and this base provides
// the request surface those hooks use: the input bag the hook writes into
// (`merge()`) and the data the validation reads.
//
// Laravel's FormRequest IS a request (it extends Illuminate\Http\Request), so
// the base holds the request the runtime built and forwards to it. The
// semantics are Laravel's: `merge()` puts the input into the request's INPUT
// SOURCE and every key REPLACES the value (it is not a deep merge), the dot
// notation is honoured (Arr::set) - see kernel/http.mjs.
//
// The lifecycle Laravel runs on the request (ValidatesWhenResolvedTrait:
// prepareForValidation -> the validator -> withValidator -> after -> the rules
// -> passedValidation) is driven by the COMPILED handler: the kernel has no
// container and no ValidationFactory, so the validator is handed in - see
// setValidator() / getValidatorInstance().
import { ValidationException } from './validation.mjs';

export class FormRequest {
  constructor(request) {
    // The request the runtime built (the input bag the hooks write into).
    this.__request = request || null;
    // The validator the lifecycle runs (Laravel's FormRequest::$validator).
    this.__validator = null;
    // Illuminate\Foundation\Http\FormRequest::$errorBag (FormRequest.php:66) -
    // the bag the errors are flashed into.
    this.errorBag = 'default';
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

  // Illuminate\Http\Request::user() - the authenticated user (null when there
  // is none). The `authorize()` hook reads it ("return $this->user()->isAdmin()"),
  // so the base forwards it to the request. The request's own user() is
  // ASYNC at the edge (the guard reads D1), so the compiled body awaits it -
  // the base returns the promise the request gives.
  user() {
    if (!this.__request || typeof this.__request.user !== 'function') return null;
    return this.__request.user();
  }

  // Illuminate\Foundation\Http\FormRequest::validationData() (FormRequest.php:197)
  // - the data the rules see. Laravel's default is the whole request.
  validationData() {
    return this.all();
  }

  // Illuminate\Foundation\Http\FormRequest::setValidator() (FormRequest.php:463).
  setValidator(validator) {
    this.__validator = validator;
    return this;
  }

  // Illuminate\Foundation\Http\FormRequest::getValidatorInstance()
  // (FormRequest.php:94-121) - the validator the hooks receive.
  //
  // Laravel builds it with the container's ValidationFactory (and asks the app
  // for its own one when the app overrides the validator() hook,
  // FormRequest.php:104-106). The kernel has neither, so the compiled
  // lifecycle hands the validator in. Without one the lifecycle cannot run:
  // the edge fails loud instead of validating nothing.
  getValidatorInstance() {
    if (!this.__validator) {
      throw new Error(
        'the FormRequest has no validator: the kernel has no container and no ValidationFactory ' +
          '(Laravel builds the validator with the container\'s factory, FormRequest.php:94) - the ' +
          'compiled lifecycle must hand the validator in (setValidator) before the validation'
      );
    }
    return this.__validator;
  }

  // Illuminate\Validation\ValidatesWhenResolvedTrait::passedValidation() (the
  // trait declares it at line 63) - the default does nothing; the app's own
  // override replaces it.
  passedValidation() {}

  // Illuminate\Validation\ValidatesWhenResolvedTrait::failedValidation() (the
  // trait declares it at line 76) - Laravel throws the ValidationException,
  // and the HTTP kernel renders it (the 422 body with the error bag).
  failedValidation(validator) {
    throw new ValidationException(validator.errors(), { errorBag: this.errorBag });
  }
}

export default { FormRequest };
