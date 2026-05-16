// ════════════════════════════════════════════════════════════════
//  GET  /api/manipulation/watchlists[?type=&symbol=&history=1]
//  POST /api/manipulation/watchlists  body: { symbol }
//  Alias — re-exports the existing manipulation-engine handlers.
// ════════════════════════════════════════════════════════════════
export { GET, POST } from '../../manipulation-engine/watchlists/route';
