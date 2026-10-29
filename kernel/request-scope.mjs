// kernel/request-scope.mjs - the ambient "current request" (Laravel's app('request')).
//
// PHP resolves a JsonResource at json_encode() time: the resource is
// JsonSerializable, so `json_encode($resource)` calls jsonSerialize() ->
// resolve($request = null) -> `$request ?: Container::getInstance()->make('request')`
// - the request the application is handling right now. A NESTED resource
// (`'child' => new ChildResource($x)` inside another resource's toArray())
// walks the same path at the same moment, which is why the encoder needs the
// live request too.
//
// The kernel has no container, so the compiled runtime (rt-from-context) hands
// the live request in - and republishes it for every rt it builds, so a view's
// own rt or a static snapshot never leaves a stale request behind (without an
// HTTP context the runtime's provider fails loud, like the container would).
// With no provider installed at all (a kernel unit test) the answer is null, so
// a resource whose toArray() ignores the request still resolves.
let provider = () => null;

/** Install the resolver the runtime's live request comes from. */
export function setRequestProvider(fn) {
  provider = typeof fn === 'function' ? fn : () => null;
}

/** The request the application is handling, or null outside an HTTP context. */
export function currentRequest() {
  return provider();
}

export default { setRequestProvider, currentRequest };
