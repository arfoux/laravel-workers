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
  // PHP's rfc1867 parser (ext/standard/rfc1867.c): the delimiter is
  // CRLF + "--boundary" - a file whose CONTENT contains the boundary bytes
  // must not end the part (the edge searched the bare bytes, so such a file
  // truncated the upload). The FIRST boundary starts the body (no CRLF before
  // it).
  const findDelimiter = (from) => {
    let at = from;
    for (;;) {
      const found = indexOfBytes(bytes, delim, at);
      if (found === -1) return -1;
      if (found === 0 || (bytes[found - 1] === 10 && bytes[found - 2] === 13)) return found;
      at = found + 1;
    }
  };
  let pos = findDelimiter(0);
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
    const next = findDelimiter(bodyStart);
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
        setFile(files, name, {
          name,
          filename,
          mime,
          bytes: content,
          size: content.length,
          __part: true,
        });
      } else {
        fields[name] = dec.decode(content);
      }
    }
    pos = next + delim.length;
  }
  return { fields, files };
}

// PHP's $_FILES naming: 'photos[]' is an append, 'photos[0]' is an index,
// 'a[b]' is a key. The parser writes the files into the same shape.
function setFile(files, name, desc) {
  const m = /^([^[\]]*)((?:\[[^[\]]*\])*)$/.exec(name);
  const base = m ? m[1] : name;
  const brackets = m ? m[2] : '';
  if (!brackets) {
    if (base === '') files[''] = desc;
    else files[base] = desc;
    return;
  }
  // The path: the base + every bracket key ('' means "append").
  const keys = brackets.slice(1, -1).split('][');
  let node = files;
  let container = base;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (container === '') {
      container = '0';
      if (!node[container] || typeof node[container] !== 'object') node[container] = [];
    }
    let child = node[container];
    if (!child || typeof child !== 'object' || child.__uploadedFile || child.__part) {
      // The next key decides the shape: '' or a number is a list, else a map.
      const next = keys[i + 1];
      child = next === undefined || next === '' || /^\d+$/.test(next) ? [] : {};
      node[container] = child;
    }
    if (Array.isArray(child)) {
      if (key === '') {
        // The last segment: append the file.
        if (i === keys.length - 1) {
          child.push(desc);
          return;
        }
        const created = [];
        child.push(created);
        node = created;
        container = '';
        continue;
      }
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0) continue;
      if (i === keys.length - 1) {
        child[idx] = desc;
        return;
      }
      if (!child[idx] || typeof child[idx] !== 'object') child[idx] = [];
      node = child[idx];
      container = '';
      continue;
    }
    if (i === keys.length - 1) {
      child[key] = desc;
      return;
    }
    const next = keys[i + 1];
    if (!child[key] || typeof child[key] !== 'object') {
      child[key] = next === '' || /^\d+$/.test(next) ? [] : {};
    }
    node = child[key];
    container = key;
  }
}

export default { parseMultipart };
