// kernel/resources.mjs — the API resources (Illuminate\Http\Resources\Json).
//
// A resource is the edge's answer to "the app's own JSON shape": the `data`
// wrapper, the conditional attributes (`whenLoaded`, `whenNotNull`,
// `mergeWhen`), the top-level `additional` keys and the `links`/`meta` of a
// paginated collection. Every rule below was probed against the real Laravel
// 13 (the oracle: the fixture app's vendor) - the comment above each rule
// names the file:line the probe pinned.
//
// The app's own `toArray()` WINS. The base class only carries Laravel's
// fallback (`JsonResource::toArray()` - JsonResource.php:170-178): it never
// merges Laravel's defaults over the array the app returned.
//
// Not ported: the `PreserveKeys`/`Collects` attributes (the compiled class
// carries the collects class directly), the macros and the `Responsable`
// plumbing of the response factory (the runtime builds the response).

import { phpJsonEncode } from './php-json.mjs';

// Laravel's `MissingValue` (Illuminate\Http\Resources\MissingValue): the
// sentinel a conditional attribute returns when it must NOT appear in the
// array. The filter drops it (ConditionallyLoadsAttributes.php:92-118).
class MissingValue {}

// Laravel's `MergeValue` (Illuminate\Http\Resources\MergeValue): the
// sentinel `mergeWhen()` returns. The filter merges its data into the parent
// array (ConditionallyLoadsAttributes.php:55-79).
//
// It is a PLAIN object with the public `data` property, exactly like
// Laravel's: a merge that landed on a string key is not merged (the filter
// merges the numeric keys only - ConditionallyLoadsAttributes.php:44-47) and
// Laravel's json_encode then answers the object's property - `{"data":{...}}`
// (a probe). The marker is not enumerable, so it never reaches the body.
const MERGE_VALUE = '__lwMergeValue';

function newMergeValue(data) {
  const value = { data };
  Object.defineProperty(value, MERGE_VALUE, { value: true, enumerable: false });
  return value;
}

function isMergeValue(value) {
  return value !== null && typeof value === 'object' && value[MERGE_VALUE] === true;
}

// Laravel's `value()` helper (Illuminate/Support/helpers.php): a Closure is
// called, everything else is returned as it is.
function phpValue(value, ...args) {
  return typeof value === 'function' ? value(...args) : value;
}

// PHP's `array_merge()`: a string key is overwritten by the later array, a
// numeric key is APPENDED (re-indexed), and the order follows the arguments.
function phpArrayMerge(...arrays) {
  const out = {};
  for (const array of arrays) {
    if (!array || typeof array !== 'object') continue;
    for (const key of phpKeysOf(array)) {
      const value = array[key];
      if (isNumericKey(key)) {
        out[Object.keys(out).length] = value;
        continue;
      }
      out[key] = value;
    }
  }
  return out;
}

// PHP's `array_merge_recursive()`: the numeric keys are appended, the string
// keys are merged - two arrays under the same key are merged, two values
// under the same key become an array of both.
function phpArrayMergeRecursive(...arrays) {
  const out = {};
  for (const array of arrays) {
    if (!array || typeof array !== 'object') continue;
    for (const key of Object.keys(array)) {
      const value = array[key];
      if (isNumericKey(key)) {
        out[out.length] = value;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        const previous = out[key];
        if (Array.isArray(previous) && Array.isArray(value)) {
          out[key] = phpArrayMergeRecursive(previous, value);
        } else {
          out[key] = [previous, value];
        }
        continue;
      }
      out[key] = value;
    }
  }
  return out;
}

// PHP's `is_numeric()` on an array key: a canonical decimal integer.
function isNumericKey(key) {
  return /^(0|-?[1-9][0-9]*)$/.test(key) && Number.isSafeInteger(Number(key));
}

// `array_key_exists()` on the array the resource resolved.
function hasKey(data, key) {
  return Object.prototype.hasOwnProperty.call(data, key);
}

// `empty()`: the falsy values of PHP (null, false, 0, 0.0, '', '0', []).
function phpEmpty(value) {
  if (value === null || value === undefined) return true;
  if (value === false || value === 0 || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

// The `data` wrapper of the resource's class. PHP's static property is SHARED
// with the subclasses (a probe: `ResA::withoutWrapping()` left
// `JsonResource::$wrap` null - JsonResource.php:52 and :326-330), so the
// wrapper is read from the class the resource was built from.
function wrapperKeyOf(resource) {
  const ctor = resource && resource.constructor;
  const wrap = ctor && ctor.wrap !== undefined ? ctor.wrap : JsonResource.wrap;
  return wrap === null || wrap === undefined || wrap === '' ? null : String(wrap);
}

// The compiled class registry: the runtime hands the resolver over so a
// collection can find the resource class it collects (the `collects()`
// convention - CollectsResources.php:59-88). Without it the convention
// cannot be resolved and the collection fails loud.
let resourceResolver = null;

// The resolver: `name` (an FQCN) -> a resource class (a constructor) or a
// factory `(item) => resource`.
export function setResourceResolver(fn) {
  resourceResolver = typeof fn === 'function' ? fn : null;
}

function resolveResourceClass(name) {
  if (!resourceResolver) return null;
  const found = resourceResolver(name);
  return found === undefined ? null : found;
}

// The class name of the collection: the FQCN the runtime stamped on the
// instance (`__lwClass`), else the constructor's name.
function classNameOf(instance) {
  if (instance && instance.__lwClass) return String(instance.__lwClass);
  if (instance && instance.constructor && instance.constructor.name) {
    return instance.constructor.name;
  }
  return '';
}

// The resource class a collection collects (CollectsResources::collects() -
// CollectsResources.php:59-88): the explicit `$collects`, else the class-name
// convention (`UserCollection` -> `User`, else `UserResource`).
function collectsClassOf(collection) {
  if (collection.collects) return collection.collects;
  const name = classNameOf(collection);
  if (!name.endsWith('Collection')) return null;
  const stem = name.slice(0, name.length - 'Collection'.length);
  const found = resolveResourceClass(stem) || resolveResourceClass(stem + 'Resource');
  if (found) return found;
  if (!resourceResolver) {
    throw new Error(
      'the resource collection ' + name +
        ' collects a class the edge cannot resolve (the runtime must register the compiled ' +
        'resource classes) - the collection would answer the raw models where Laravel answers the resources'
    );
  }
  return null;
}

// Build one item of a collection: the collects class is a constructor (a
// compiled `class X extends JsonResource`) or a factory (the runtime's
// `newClass`).
function instantiateCollects(collects, item) {
  if (typeof collects !== 'function') {
    throw new Error('the collected resource class is not a class - the edge cannot build it');
  }
  if (collects === JsonResource || collects.prototype instanceof JsonResource) {
    return new collects(item);
  }
  return collects(item);
}

// The items of a collection: an array, a Collection or a paginator
// (CollectsResources::collectResource() - CollectsResources.php:27-49).
function itemsOf(resource) {
  if (Array.isArray(resource)) return resource;
  if (resource && typeof resource.items === 'function') return resource.items();
  if (resource && typeof resource.all === 'function') return resource.all();
  throw new Error(
    'the resource collection must be built from an array, a Collection or a paginator - ' +
      'the edge got ' + describe(resource)
  );
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

// A paginator: the edge's LengthAwarePaginator (Illuminate\Pagination) and
// anything that answers the same surface. Laravel checks
// `$resource instanceof AbstractPaginator` (ResourceCollection.php:118).
function isPaginator(resource) {
  return (
    resource !== null &&
    typeof resource === 'object' &&
    !Array.isArray(resource) &&
    typeof resource.currentPage === 'function' &&
    typeof resource.lastPage === 'function' &&
    typeof resource.perPage === 'function' &&
    typeof resource.total === 'function'
  );
}

// The `toArray()` of the wrapped model: the edge's Model answers it through
// `toJSON()` (Laravel's `Model::toArray()` is what `jsonSerialize()`
// returns), a plain object through `toArray()`.
function modelToArray(model) {
  if (model === null || model === undefined) return null;
  if (typeof model.toArray === 'function') return model.toArray();
  if (typeof model.toJSON === 'function') return model.toJSON();
  if (typeof model === 'object' && !Array.isArray(model)) return { ...model };
  return model;
}

// Laravel's `DelegatesToResource::__get()` (DelegatesToResource.php:120-123):
// a property the resource does not have comes from the wrapped model. The
// edge installs it on the prototype, so a compiled resource reads `$this->id`
// as the model's attribute (the compiled `rt.prop(this, "id")`).
function installPropertyProxy(instance) {
  const proto = Object.getPrototypeOf(instance);
  const read = (model, prop) => {
    if (!model || typeof model !== 'object') return undefined;
    // A relation: the value the model loaded (`Model::relationLoaded()`).
    if (typeof model.relationLoaded === 'function' && model.relationLoaded(prop)) {
      return typeof model.getRelation === 'function' ? model.getRelation(prop) : model[prop];
    }
    // An attribute: through the model's `get()` (the casts + the accessors).
    if (model.attributes && typeof model.attributes === 'object' && hasKey(model.attributes, prop)) {
      return typeof model.get === 'function' ? model.get(prop) : model[prop];
    }
    // A plain object: its own property.
    if (
      !Array.isArray(model) &&
      !(model.attributes && typeof model.attributes === 'object') &&
      hasKey(model, prop)
    ) {
      return model[prop];
    }
    return undefined;
  };
  const proxy = new Proxy(proto, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (prop in target) return Reflect.get(target, prop, receiver);
      return read(instance.resource, prop);
    },
    // `in` does NOT pass the receiver (V8 calls `has(target, prop)`), so the
    // resource is read off the closed-over instance - the proxy is installed
    // per instance, so it is the same object the `get` trap sees.
    has(target, prop) {
      if (typeof prop === 'symbol') return Reflect.has(target, prop);
      if (Reflect.has(target, prop)) return true;
      return read(instance.resource, prop) !== undefined;
    },
  });
  Object.setPrototypeOf(instance, proxy);
}

/**
 * Illuminate\Http\Resources\Json\JsonResource
 */
export class JsonResource {
  // The "data" wrapper (JsonResource.php:52). PHP's static property is shared
  // with the subclasses, so a subclass that does not declare its own inherits
  // this one.
  static wrap = 'data';
  // Force the wrapping even when the resource's own array carries the
  // wrapper key (JsonResource.php:55).
  static forceWrapping = false;

  constructor(resource) {
    this.resource = resource;
    // The additional metadata of the response (JsonResource.php:42).
    this.additionalData = [];
    // The additional top-level keys of the response (JsonResource.php:37).
    this.with = [];
    installPropertyProxy(this);
  }

  // ---- the static surface -------------------------------------------------

  /** `JsonResource::make(...$parameters)` (JsonResource.php:80-83). */
  static make(...parameters) {
    return new this(...parameters);
  }

  /** `JsonResource::wrap($value)` (JsonResource.php:296-299). */
  static setWrap(value) {
    // PHP: the static property is shared with the parent unless the class
    // declares its own (a probe: `ResA::withoutWrapping()` left
    // `JsonResource::$wrap` null).
    const target = Object.prototype.hasOwnProperty.call(this, 'wrap') ? this : JsonResource;
    target.wrap = value;
  }

  /** `JsonResource::withoutWrapping()` (JsonResource.php:306-309). */
  static withoutWrapping() {
    const target = Object.prototype.hasOwnProperty.call(this, 'wrap') ? this : JsonResource;
    target.wrap = null;
  }

  /** `JsonResource::flushState()` (JsonResource.php:324-328). */
  static flushState() {
    JsonResource.wrap = 'data';
    JsonResource.forceWrapping = false;
  }

  /**
   * `JsonResource::collection($resource)` (JsonResource.php:90-104) - the
   * anonymous collection of this resource class.
   */
  static collection(resource) {
    return new AnonymousResourceCollection(resource, this);
  }

  // ---- the instance surface -----------------------------------------------

  /**
   * The array the resource returns (JsonResource.php:170-178). The APP's own
   * `toArray()` overrides this one - the base never merges Laravel's
   * defaults over the app's array.
   */
  toArray(request) {
    if (this.resource === null || this.resource === undefined) return [];
    if (Array.isArray(this.resource)) return this.resource;
    return modelToArray(this.resource);
  }

  /**
   * The attributes of the resource (JsonResource.php:144-151): the app's
   * `$attributes` property when it declares one, else `toArray()`.
   */
  toAttributes(request) {
    if (Object.prototype.hasOwnProperty.call(this, 'attributes')) return this.attributes;
    return this.toArray(request);
  }

  /** `JsonResource::resolveResourceData()` (JsonResource.php:155-160). */
  resolveResourceData(request) {
    return this.toAttributes(request);
  }

  /**
   * `JsonResource::resolve()` (JsonResource.php:117-133): the data of the
   * resource, filtered (the missing values dropped, the merged values folded
   * into the parent).
   */
  resolve(request) {
    const data = this.resolveResourceData(request);
    return this.filter(toArrayOf(data));
  }

  /** `JsonResource::jsonSerialize()` (JsonResource.php:312-315). */
  jsonSerialize() {
    return this.resolve();
  }

  /**
   * `JsonResource::toJson()` (JsonResource.php:186-196): the JSON of the
   * RESOLVED data - the `data` wrapper is NOT applied here (the wrapper is
   * the response's job - ResourceResponse.php:60-73).
   */
  toJson(options = 0) {
    return encodeJson(this.jsonSerialize(), options);
  }

  /** `JsonResource::toPrettyJson()` (JsonResource.php:205-208). */
  toPrettyJson(options = 0) {
    return this.toJson(JSON_PRETTY_PRINT | options);
  }

  /** The additional top-level keys of the response (JsonResource.php:214-217). */
  withData() {
    return this.with;
  }

  /**
   * `JsonResource::additional($data)` (JsonResource.php:224-231): the extra
   * TOP-LEVEL keys of the response (they are NOT inside `data`).
   */
  additional(data) {
    this.additionalData = data;
    return this;
  }

  /** `JsonResource::jsonOptions()` (JsonResource.php:237-240). */
  jsonOptions() {
    return 0;
  }

  // ---- the conditional attributes -----------------------------------------

  /**
   * `when($condition, $value, $default)` (ConditionallyLoadsAttributes.php:126-133).
   * Without a default the key does NOT appear when the condition is false -
   * Laravel answers the `MissingValue` sentinel, which the filter drops
   * (:120-124). Answering `undefined` here would reach `json_encode` and
   * fail there instead (a JS value that is not a PHP value at all).
   */
  when(condition, value, defaultValue) {
    if (condition) return phpValue(value);
    return arguments.length === 3 ? phpValue(defaultValue) : new MissingValue();
  }

  /** `unless($condition, $value, $default)` (ConditionallyLoadsAttributes.php:140-147). */
  unless(condition, value, defaultValue) {
    if (arguments.length === 2) return this.when(!condition, value);
    return this.when(!condition, value, defaultValue);
  }

  /** `whenNotNull($value, $default)` (ConditionallyLoadsAttributes.php:243-250). */
  whenNotNull(value, defaultValue) {
    if (arguments.length === 1) return this.when(value !== null && value !== undefined, value);
    return this.when(value !== null && value !== undefined, value, defaultValue);
  }

  /** `whenNull($value, $default)` (ConditionallyLoadsAttributes.php:230-237). */
  whenNull(value, defaultValue) {
    if (arguments.length === 1) return this.when(value === null || value === undefined, value);
    return this.when(value === null || value === undefined, value, defaultValue);
  }

  /**
   * `whenLoaded($relationship, $value, $default)`
   * (ConditionallyLoadsAttributes.php:272-293): the key appears ONLY when the
   * relation is loaded. The edge's "loaded" is what the model reports
   * (`Model::relationLoaded()` - the relation was eager-loaded or set).
   */
  whenLoaded(relationship, value, defaultValue) {
    const model = this.resource;
    const loaded =
      model !== null &&
      model !== undefined &&
      typeof model.relationLoaded === 'function' &&
      model.relationLoaded(relationship);
    if (!loaded) {
      return arguments.length === 3 ? phpValue(defaultValue) : new MissingValue();
    }
    const loadedValue = readRelation(model, relationship);
    if (arguments.length === 1) return loadedValue;
    // Laravel: a loaded relation that is null answers null (the key IS there).
    if (loadedValue === null || loadedValue === undefined) return null;
    // Laravel: a null `$value` becomes `value(...)` - the first-class
    // callable of `value()`, which answers the loaded value.
    if (value === null || value === undefined) return phpValue(loadedValue);
    return phpValue(value, loadedValue);
  }

  /**
   * `whenHas($attribute, $value, $default)`
   * (ConditionallyLoadsAttributes.php:219-232).
   */
  whenHas(attribute, value, defaultValue) {
    const model = this.resource;
    const attributes = attributesOf(model);
    if (!attributes || !hasKey(attributes, attribute)) {
      // Laravel: the default answers only when it was given (the third
      // argument) - with one or two arguments the key does NOT appear.
      return arguments.length === 3 ? phpValue(defaultValue) : new MissingValue();
    }
    if (arguments.length === 1) return readAttribute(model, attribute);
    return phpValue(value, readAttribute(model, attribute));
  }

  /**
   * `mergeWhen($condition, $value, $default)`
   * (ConditionallyLoadsAttributes.php:168-177): the value is MERGED into the
   * parent array - it does not become a key of its own.
   */
  mergeWhen(condition, value, defaultValue) {
    if (condition) return newMergeValue(phpValue(value));
    return arguments.length === 3 ? newMergeValue(phpValue(defaultValue)) : new MissingValue();
  }

  /** `mergeUnless($condition, $value, $default)` (ConditionallyLoadsAttributes.php:184-193). */
  mergeUnless(condition, value, defaultValue) {
    if (arguments.length === 2) return this.mergeWhen(!condition, value);
    return this.mergeWhen(!condition, value, defaultValue);
  }

  /** `merge($value)` (ConditionallyLoadsAttributes.php:155-158). */
  merge(value) {
    return this.mergeWhen(true, value);
  }

  /** `attributes($attributes)` (ConditionallyLoadsAttributes.php:200-205). */
  attributes(attributes) {
    const all = modelToArray(this.resource) || {};
    const picked = {};
    for (const key of attributes || []) {
      if (hasKey(all, key)) picked[key] = all[key];
    }
    return newMergeValue(picked);
  }

  // ---- the filter ----------------------------------------------------------

  /**
   * `ConditionallyLoadsAttributes::filter()`
   * (ConditionallyLoadsAttributes.php:27-53): the missing values are dropped
   * and the merged values are folded into the parent array.
   */
  filter(data) {
    const out = {};
    let index = -1;
    // PHP's array order: the insertion order the literal recorded (a JS
    // object would enumerate an integer-like key first - rt.assoc's marker).
    for (const key of Array.isArray(data.__lwOrder) ? data.__lwOrder : Object.keys(data)) {
      index++;
      const value = data[key];
      if (Array.isArray(value)) {
        out[key] = this.filter(value);
        continue;
      }
      if (isNumericKey(key) && isMergeValue(value)) {
        const merged = this.filter(toArrayOf(value.data));
        // Laravel slices the WHOLE `$data` (ConditionallyLoadsAttributes.php:
        // 33-40): the keys AFTER the merge are not in `out` yet, so the tail
        // is taken from the original array and filtered inside mergeData.
        return this.mergeData(out, index, merged, isListOf(value.data), sliceFrom(data, index + 1));
      }
      out[key] = value;
    }
    return this.removeMissingValues(out);
  }

  /**
   * `ConditionallyLoadsAttributes::mergeData()`
   * (ConditionallyLoadsAttributes.php:60-79).
   */
  mergeData(data, index, merge, numericKeys, rest) {
    // ConditionallyLoadsAttributes.php:60-79, both branches verbatim.
    if (numericKeys) {
      // `array_merge(array_merge(slice(0,index), merge), filter(values(slice(index+1))))`
      // - array_merge, NOT array_merge_recursive: a duplicate string key is
      // overwritten and a numeric key is appended.
      const head = phpArrayMerge(sliceFrom(data, 0, index), merge);
      const tail = this.filter(valuesOf(rest || {}));
      return this.removeMissingValues(phpArrayMerge(head, tail));
    }
    // `slice(0,index) + merge + filter(slice(index+1))`: PHP's `+` keeps the
    // LEFT side for a duplicate key, and the ORDER is head, merge, tail.
    const head = sliceFrom(data, 0, index);
    const tail = this.filter(rest || {});
    const out = {};
    for (const src of [head, merge, tail]) {
      for (const key of phpKeysOf(src)) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = src[key];
      }
    }
    return this.removeMissingValues(out);
  }

  /**
   * `ConditionallyLoadsAttributes::removeMissingValues()`
   * (ConditionallyLoadsAttributes.php:92-118): the missing values are dropped
   * and a list keeps its order (the keys are re-indexed).
   */
  removeMissingValues(data) {
    const out = {};
    let numericKeys = true;
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (value instanceof MissingValue) continue;
      if (!isNumericKey(key)) numericKeys = false;
      out[key] = value;
    }
    if (numericKeys) return Object.values(out);
    return out;
  }
}

/**
 * Illuminate\Http\Resources\Json\ResourceCollection
 */
export class ResourceCollection extends JsonResource {
  constructor(resource, collects) {
    super(resource);
    this.collects = collects || null;
    this.collection = null;
  }

  // The mapped items (CollectsResources::collectResource() -
  // CollectsResources.php:27-49). The mapping is lazy: the compiled class
  // registry is only complete once the runtime stamped the class name.
  items() {
    if (this.collection) return this.collection;
    const collects = collectsClassOf(this);
    const items = itemsOf(this.resource);
    this.collection = collects
      ? items.map((item) => instantiateCollects(collects, item))
      : items.slice();
    return this.collection;
  }

  /**
   * `ResourceCollection::toArray()` (ResourceCollection.php:104-112): the
   * items are resolved when they are resources already, else their own
   * `toArray()` is taken.
   */
  toArray(request) {
    const items = this.items();
    if (items.length && items[0] instanceof JsonResource) {
      return items.map((item) => item.resolve(request));
    }
    return items.map((item) => {
      if (item instanceof JsonResource) return item.resolve(request);
      if (item && typeof item.toArray === 'function') return item.toArray(request);
      if (item && typeof item.toJSON === 'function') return item.toJSON();
      return item;
    });
  }

  /** `ResourceCollection::count()` (ResourceCollection.php:88-91). */
  count() {
    return this.items().length;
  }

  /** The paginator the collection carries, when it is paginated. */
  paginator() {
    return isPaginator(this.resource) ? this.resource : null;
  }
}

/**
 * Illuminate\Http\Resources\Json\AnonymousResourceCollection
 */
export class AnonymousResourceCollection extends ResourceCollection {}

// PHP's `json_encode()` flags the edge honours.
const JSON_PRETTY_PRINT = 128;

/**
 * The JSON of a value, with PHP's `json_encode()` bytes (the slashes
 * escaped, the non-ASCII as `\uXXXX` - the same bytes the edge's session
 * cookie carries).
 */
function encodeJson(value, options = 0) {
  if (!options) return phpJsonEncode(value);
  if (options & JSON_PRETTY_PRINT) return prettyJson(value);
  throw new Error(
    'the json_encode option ' + options + ' is not supported at the edge - ' +
      'only the default flags and JSON_PRETTY_PRINT are'
  );
}

// PHP's `json_encode($value, JSON_PRETTY_PRINT)`: four spaces of indent, the
// same escaping as the default flags.
function prettyJson(value) {
  return prettyValue(value, 0);
}

function prettyValue(value, depth) {
  const pad = '    '.repeat(depth + 1);
  const closePad = '    '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const parts = value.map((item) => pad + prettyValue(item, depth + 1));
    return '[\n' + parts.join(',\n') + '\n' + closePad + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return phpJsonEncode(value);
    const parts = keys.map(
      (key) => pad + phpJsonEncode(String(key)) + ': ' + prettyValue(value[key], depth + 1)
    );
    return '{\n' + parts.join(',\n') + '\n' + closePad + '}';
  }
  return phpJsonEncode(value);
}

// The data of a resolved resource as an array (PHP's `(array) $data`).
function toArrayOf(data) {
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object') {
    if (typeof data.toArray === 'function') return toArrayOf(data.toArray());
    if (typeof data.jsonSerialize === 'function') return toArrayOf(data.jsonSerialize());
    return { ...data };
  }
  return [data];
}

// A list: the keys are 0..n-1 in order (PHP's `array_values($a) === $a`).
function isListOf(data) {
  if (!Array.isArray(data)) return false;
  for (let i = 0; i < data.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(data, i)) return false;
  }
  return true;
}

// `array_slice($array, $offset)` with the keys preserved.
// PHP's key order: the insertion order the literal recorded (a JS object
// enumerates an integer-like key first, PHP does not).
function phpKeysOf(data) {
  if (data && typeof data === 'object' && Array.isArray(data.__lwOrder)) return data.__lwOrder;
  return Object.keys(data || {});
}

// PHP's `array_slice($data, $offset, $length, true)`: the keys are PRESERVED
// and `$end` is EXCLUSIVE (undefined = to the end). The merge path passes the
// merge's own index as the end, so a wrong `end` would silently fold the
// merge value into the head (ConditionallyLoadsAttributes.php:60-79).
function sliceFrom(data, offset, end) {
  const out = {};
  const keys = phpKeysOf(data);
  const stop = end === undefined ? keys.length : Math.min(end, keys.length);
  for (let i = offset; i < stop; i++) {
    out[keys[i]] = data[keys[i]];
  }
  return out;
}

// The values of an array (PHP's `array_values()`).
function valuesOf(data) {
  return Object.keys(data).map((key) => data[key]);
}

// The relation value of a model (the loaded relation, else the attribute).
function readRelation(model, relationship) {
  if (typeof model.getRelation === 'function') {
    const relation = model.getRelation(relationship);
    if (relation !== undefined) return relation;
  }
  if (typeof model.get === 'function') return model.get(relationship);
  return model[relationship];
}

function readAttribute(model, attribute) {
  if (typeof model.get === 'function') return model.get(attribute);
  return model[attribute];
}

// The raw attributes of a model (Laravel's `Model::getAttributes()`; the
// edge's model carries them in `attributes`).
function attributesOf(model) {
  if (!model || typeof model !== 'object') return null;
  if (typeof model.getAttributes === 'function') return model.getAttributes();
  if (model.attributes && typeof model.attributes === 'object') return model.attributes;
  return null;
}

// The pagination information of a paginated collection
// (PaginatedResourceResponse::paginationInformation() -
// PaginatedResourceResponse.php:48-80): the `links` and the `meta`.
function paginationInformation(paginator) {
  const paginated = paginatorToArray(paginator);
  const meta = { ...paginated };
  delete meta.data;
  delete meta.first_page_url;
  delete meta.last_page_url;
  delete meta.prev_page_url;
  delete meta.next_page_url;
  return {
    links: {
      first: paginated.first_page_url ?? null,
      last: paginated.last_page_url ?? null,
      prev: paginated.prev_page_url ?? null,
      next: paginated.next_page_url ?? null,
    },
    meta,
  };
}

// `LengthAwarePaginator::toArray()` (LengthAwarePaginator.php:206-223) - the
// array the pagination meta is built from. The paginator owns it (one
// implementation of the serialisation, the links included).
function paginatorToArray(paginator) {
  return paginator.toArray();
}

/**
 * The BODY of a resource response: the `data` wrapper, the `with` and the
 * `additional` keys (ResourceResponse::wrap() - ResourceResponse.php:60-73).
 */
export function resourcePayload(resource, request) {
  const data = resource.resolve(request);
  const withKeys = resource.withData ? resource.withData() : resource.with;
  const additional = resource.additionalData || [];
  const paginator = typeof resource.paginator === 'function' ? resource.paginator() : null;
  if (paginator) {
    // PaginatedResourceResponse::toResponse() (PaginatedResourceResponse.php:16-30):
    // the pagination information is merged with the `with` and the
    // `additional` keys.
    const extra = phpArrayMergeRecursive(
      paginationInformation(paginator),
      withKeys || [],
      additional || []
    );
    return wrapPayload(resource, data, extra, []);
  }
  return wrapPayload(resource, data, withKeys || [], additional || []);
}

function wrapPayload(resource, data, withKeys, additional) {
  const wrapper = wrapperKeyOf(resource);
  let payload = data;
  const hasWrapperKey = wrapper !== null && hasKey(data, wrapper);
  // `ResourceResponse::haveDefaultWrapperAndDataIsUnwrapped()`
  // (ResourceResponse.php:79-89).
  const defaultWrapper = wrapper !== null && !hasWrapperKey;
  // `ResourceResponse::haveAdditionalInformationAndDataIsUnwrapped()`
  // (ResourceResponse.php:95-103).
  const extraInformation =
    (!phpEmpty(withKeys) || !phpEmpty(additional)) && (wrapper === null || !hasWrapperKey);
  if (defaultWrapper) {
    payload = { [wrapper]: data };
  } else if (extraInformation) {
    payload = { [wrapper === null ? 'data' : wrapper]: data };
  }
  return phpArrayMergeRecursive(payload, withKeys || [], additional || []);
}

/**
 * The RESPONSE of a resource: the body, the JSON content type and the status
 * (ResourceResponse::toResponse() - ResourceResponse.php:31-52).
 */
export function resourceResponse(resource, request) {
  const status =
    resource.resource && resource.resource.wasRecentlyCreated ? 201 : 200;
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: phpJsonEncode(resourcePayload(resource, request)),
  };
}

export default {
  JsonResource,
  ResourceCollection,
  AnonymousResourceCollection,
  resourcePayload,
  resourceResponse,
  setResourceResolver,
};
