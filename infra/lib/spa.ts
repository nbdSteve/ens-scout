/**
 * Viewer-request function used only on the static shell behavior.
 *
 * Extensionless application routes are rewritten to index.html. A request for a
 * concrete file keeps its path, so a missing hashed asset remains a missing asset
 * instead of receiving HTML with a JavaScript content type.
 */
export const spaRewriteCode = `
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf('/api/') === 0 || uri === '/health') {
    return request;
  }
  var slash = uri.lastIndexOf('/');
  var leaf = uri.substring(slash + 1);
  if (uri === '/' || leaf === '' || leaf.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
`.trim();
