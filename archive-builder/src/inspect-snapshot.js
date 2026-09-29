import { loadSnapshot } from './snapshot.js';
const { urls, gzip_sha256 } = await loadSnapshot();
console.log(JSON.stringify({ count: urls.length, gzip_sha256, first: urls[0], last: urls.at(-1) }, null, 2));
