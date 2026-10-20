// kernel/multipart.mjs — the multipart/form-data parser (the edge has no PHP).
//
// The body is the raw bytes; the parts are split on the boundary. A part with a
// `filename` is an uploaded file (the bytes as they are), the other parts are
// the form fields.
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

function indexOfBytes(hay, needle, from) {
  outer: for (let i = Math.max(0, from); i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function parseMultipart(bytes, contentType) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error('multipart/form-data: the body must be the raw bytes');
  }
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('multipart/form-data: the boundary is missing');
  const boundary = (m[1] || m[2] || '').trim();
  const delim = enc.encode('--' + boundary);
  const fields = {};
  const files = {};
  let pos = indexOfBytes(bytes, delim, 0);
  if (pos === -1) throw new Error('multipart/form-data: the body has no boundary');
  pos += delim.length;
  for (;;) {
    // the closing delimiter is "--boundary--"
    if (bytes[pos] === 45 && bytes[pos + 1] === 45) break;
    if (bytes[pos] === 13 && bytes[pos + 1] === 10) pos += 2;
    const headEnd = indexOfBytes(bytes, enc.encode('\r\n\r\n'), pos);
    if (headEnd === -1) break;
    const head = dec.decode(bytes.subarray(pos, headEnd));
    const bodyStart = headEnd + 4;
    const next = indexOfBytes(bytes, delim, bodyStart);
    if (next === -1) break;
    // the part's body ends with a CRLF before the delimiter
    let end = next;
    if (end >= 2 && bytes[end - 1] === 10 && bytes[end - 2] === 13) end -= 2;
    const content = bytes.subarray(bodyStart, end);
    let name = null;
    let filename = null;
    let mime = 'application/octet-stream';
    for (const line of head.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'content-disposition') {
        const nm = /name="([^"]*)"/i.exec(value);
        if (nm) name = nm[1];
        const fn = /filename="([^"]*)"/i.exec(value);
        if (fn) filename = fn[1];
      } else if (key === 'content-type') {
        mime = value;
      }
    }
    if (name !== null) {
      if (filename !== null) {
        files[name] = { name, filename, mime, bytes: content, size: content.length };
      } else {
        fields[name] = dec.decode(content);
      }
    }
    pos = next + delim.length;
  }
  return { fields, files };
}

export default { parseMultipart };
